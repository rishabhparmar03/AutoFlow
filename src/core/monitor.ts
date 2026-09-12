import { EventEmitter } from 'events';
import { connectionManager } from './connection';
import { deployerEngine } from './deployer';
import { GlobalConfig } from './config';

export interface ServerStats {
    cpu: string;       // e.g., "12.4%"
    ram: string;       // e.g., "482 MB / 1024 MB"
    ramPercent: number;// e.g., 47
    disk: string;      // e.g., "12 GB / 40 GB"
    diskPercent: number;// e.g., 30
    uptime: string;    // e.g., "14 days, 3 hours"
    latency: string;   // e.g., "45 ms"
    containers: Array<{
        name: string;
        cpu: string;
        mem: string;
        disk?: string;
        status: string;
    }>;
}

export class MonitorEngine {
    /**
     * Fetches stats dynamically using the persistent connection
     */
    public async fetchStats(): Promise<ServerStats> {
        if (connectionManager.getState() !== 'Connected') {
            throw new Error('Not connected to server');
        }

        const startTime = Date.now();

        try {
            // A single optimized bash script to fetch all metrics instantly in one SSH roundtrip
            const megaScript = `
                cpu=$(top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}' || echo "0")
                ram=$(free -m | awk '/Mem:/ {print $3 " MB / " $2 " MB"}' || echo "0 MB / 0 MB")
                disk=$(df -h / | tail -n 1 | awk '{print $3 " / " $2 "," $5}' || echo "0 / 0,0")
                uptime_val=$(uptime -p | sed 's/^up //' || echo "Unknown")

                ps_out=$(docker ps -a --format '{{.Names}}#{{.Status}}' 2>/dev/null)
                stats_out=$(docker stats --no-stream --format '{{.Name}}#{{.CPUPerc}}#{{.MemUsage}}' 2>/dev/null)
                size_out=$(docker ps -a -s --format '{{.Names}}#{{.Size}}' 2>/dev/null)

                echo -n "{\\"cpu\\":\\"$cpu\\",\\"ram\\":\\"$ram\\",\\"disk\\":\\"$disk\\",\\"uptime\\":\\"$uptime_val\\",\\"docker\\":["
                first=1
                while IFS= read -r line; do
                    if [ -z "$line" ]; then continue; fi
                    name="\${line%%#*}"
                    status="\${line#*#}"
                    if [ $first -eq 1 ]; then first=0; else echo -n ","; fi
                    
                    cpu_usage="0%"
                    mem_usage="0MB"
                    disk_usage="0B"
                    stats_line=$(echo "$stats_out" | grep "^$name#" || true)
                    if [ -n "$stats_line" ]; then
                        cpu_usage=$(echo "$stats_line" | cut -d'#' -f2)
                        mem_usage=$(echo "$stats_line" | cut -d'#' -f3 | awk '{print $1}')
                    fi
                    size_line=$(echo "$size_out" | grep "^$name#" || true)
                    if [ -n "$size_line" ]; then
                        disk_raw=$(echo "$size_line" | cut -d'#' -f2)
                        # Format "252MB (virtual 2.19GB)" -> extract clean string
                        disk_usage="$disk_raw"
                    fi
                    echo -n "{\\"name\\":\\"$name\\",\\"status\\":\\"$status\\",\\"cpu\\":\\"$cpu_usage\\",\\"mem\\":\\"$mem_usage\\",\\"disk\\":\\"$disk_usage\\"}"
                done <<< "$ps_out"
                echo -n "]}"
            `;

            const rawJson = await connectionManager.safeRun(megaScript);
            const latency = `${Date.now() - startTime} ms`;

            if (!rawJson) {
                throw new Error('Failed to receive stats payload');
            }

            let payload: any = {};
            try {
                payload = JSON.parse(rawJson.trim());
            } catch (parseErr) {
                console.error('[MonitorEngine] JSON Parse Error:', rawJson);
                throw new Error('Invalid JSON payload from server stats');
            }

            // 1. Process CPU
            let cpu = '0.0%';
            if (payload.cpu && payload.cpu !== '100') {
                cpu = `${parseFloat(payload.cpu).toFixed(1)}%`;
            }

            // 2. Process RAM
            let ram = payload.ram || 'N/A';
            let ramPercent = 0;
            if (ram !== 'N/A') {
                const parts = ram.split(' / ');
                if (parts.length === 2) {
                    const used = parseInt(parts[0]);
                    const total = parseInt(parts[1]);
                    if (total > 0) ramPercent = Math.round((used / total) * 100);
                }
            }

            // 3. Process Disk
            let disk = 'N/A';
            let diskPercent = 0;
            if (payload.disk) {
                const [usage, pctStr] = payload.disk.split(',');
                disk = usage || 'N/A';
                diskPercent = parseInt(pctStr, 10) || 0;
            }

            // 4. Process Uptime
            const uptime = payload.uptime || 'Unknown';

            // 5. Process Docker containers
            const containers: ServerStats['containers'] = payload.docker || [];

            // We omit PM2 and Systemd from the mega script to keep it minimal and Docker-focused.
            // If they are needed later, they can be appended to the JSON array similarly.

            return {
                cpu,
                ram,
                ramPercent,
                disk,
                diskPercent,
                uptime,
                latency,
                containers,
            };

        } catch (err: any) {
            console.error('[MonitorEngine] Failed to gather stats:', err.message);
            throw err;
        }
    }

    public async fetchRemoteLogs(name: string): Promise<string> {
        if (connectionManager.getState() !== 'Connected') {
            throw new Error('Not connected to server');
        }

        try {
            const clean = this.sanitizeContainerName(name);
            let cmd = `docker logs --tail 150 ${clean}`;
            if (name.startsWith('[pm2] ')) {
                cmd = `pm2 logs "${clean}" --raw --lines 150`;
            } else if (name.startsWith('[systemd] ')) {
                cmd = `journalctl -u "${clean}" -n 150 --no-pager`;
            }

            const result = await connectionManager.execCommand(cmd);
            return result.stdout || result.stderr || 'No logs found.';
        } catch (err: any) {
            return `Failed to fetch remote logs: ${err.message}`;
        }
    }

    private cleanName(name: string): string {
        if (name.startsWith('[pm2] ')) return name.replace('[pm2] ', '');
        if (name.startsWith('[systemd] ')) return name.replace('[systemd] ', '');
        return name;
    }

    private sanitizeContainerName(name: string): string {
        const clean = this.cleanName(name);
        if (!/^[a-zA-Z0-9_.-]+$/.test(clean)) {
            throw new Error(`Invalid container name: ${clean}`);
        }
        return clean;
    }

    // --- Container Controls ---
    public async stopContainer(name: string): Promise<boolean> {
        const clean = this.sanitizeContainerName(name);
        let success = false;
        if (name.startsWith('[pm2] ')) success = (await connectionManager.safeRun(`pm2 stop "${clean}"`)) !== null;
        else if (name.startsWith('[systemd] ')) success = (await connectionManager.safeRun(`sudo systemctl stop "${clean}"`)) !== null;
        else success = (await connectionManager.safeRun(`docker stop ${clean}`)) !== null;
        
        // Only log Docker container actions to history to avoid dashboard glitches
        if (success && !name.startsWith('[')) deployerEngine.logContainerAction(clean, 'Stopped');
        return success;
    }

    public async restartContainer(name: string): Promise<boolean> {
        const clean = this.sanitizeContainerName(name);
        let success = false;
        if (name.startsWith('[pm2] ')) success = (await connectionManager.safeRun(`pm2 restart "${clean}"`)) !== null;
        else if (name.startsWith('[systemd] ')) success = (await connectionManager.safeRun(`sudo systemctl restart "${clean}"`)) !== null;
        else success = (await connectionManager.safeRun(`docker restart ${clean}`)) !== null;

        if (success && !name.startsWith('[')) deployerEngine.logContainerAction(clean, 'Restarted');
        return success;
    }

    public async deleteContainer(name: string): Promise<boolean> {
        const clean = this.sanitizeContainerName(name);
        let success = false;
        if (name.startsWith('[pm2] ')) success = (await connectionManager.safeRun(`pm2 delete "${clean}"`)) !== null;
        else if (name.startsWith('[systemd] ')) success = false; // Not safe to delete systemd unit blindly
        else success = (await connectionManager.safeRun(`docker rm -f ${clean}`)) !== null;

        if (success && !name.startsWith('[')) deployerEngine.logContainerAction(clean, 'Deleted');
        return success;
    }
}

export const monitorEngine = new MonitorEngine();
