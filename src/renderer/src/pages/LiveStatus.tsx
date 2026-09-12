import React, { useState, useEffect } from 'react';
import { SyncIcon, WarningIcon } from '../components/Icons';

interface ContainerInfo {
    name: string;
    cpu: string;
    mem: string;
    status: string;
}

interface ServerStats {
    cpu: string;
    ram: string;
    ramPercent: number;
    disk: string;
    diskPercent: number;
    uptime: string;
    latency: string;
    containers: ContainerInfo[];
}

interface LiveStatusProps {
    stats: ServerStats | null;
    loading: boolean;
    error: string;
    onRefresh: () => void;
    onAction: () => void;
    showConfirm: (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) => void;
}

export const LiveStatus: React.FC<LiveStatusProps> = ({ stats, loading, error, onRefresh, onAction, showConfirm }) => {
    const lastUpdated = stats ? new Date() : null;

    const handleStopContainer = (name: string) => {
        showConfirm({
            title: 'Stop Container',
            message: `Stop container "${name}"? The service will go offline until restarted.`,
            confirmLabel: 'Stop',
            danger: true,
            onConfirm: async () => {
                await window.autoflow.stopContainer(name);
                onAction();
            }
        });
    };

    const handleRestartContainer = (name: string) => {
        showConfirm({
            title: 'Restart Container',
            message: `Restart container "${name}"? There will be a brief downtime.`,
            confirmLabel: 'Restart',
            onConfirm: async () => {
                await window.autoflow.restartContainer(name);
                onAction();
            }
        });
    };

    const handleDeleteContainer = (name: string) => {
        showConfirm({
            title: 'Delete Container',
            message: `Permanently delete container "${name}"? This cannot be undone. The service will go offline.`,
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
                await window.autoflow.deleteContainer(name);
                onAction();
            }
        });
    };

    const getBarColor = (pct: number) => {
        if (pct > 85) return 'var(--error)';
        if (pct > 65) return 'var(--warning)';
        return 'var(--accent)';
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', flex: 1, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
                <div>
                    <h1 className="h1">Server Monitor</h1>
                    <span className="text-secondary" style={{ fontSize: '13px' }}>
                        Live diagnostics & container parameters (SSH polled)
                    </span>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {lastUpdated && (
                        <span className="text-muted" style={{ fontSize: '11px' }}>
                            Last update: {lastUpdated.toLocaleTimeString()}
                        </span>
                    )}
                    <button 
                        onClick={onRefresh}
                        disabled={loading}
                        className="btn btn-secondary"
                        style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                        <SyncIcon size={12} /> {loading ? 'Refreshing...' : 'Refresh Now'}
                    </button>
                </div>
            </div>

            {error && (
                <div style={{ background: 'var(--error-glow)', border: '1px solid rgba(239, 68, 68, 0.2)', color: 'var(--error)', padding: '10px 14px', borderRadius: '6px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <WarningIcon size={14} /> {error}
                </div>
            )}

            {/* Top Stats Cards Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
                
                {/* CPU usage card */}
                <div className="card">
                    <span className="form-label" style={{ fontSize: '10px', textTransform: 'uppercase' }}>CPU Load</span>
                    <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0', color: 'var(--text-primary)' }}>
                        {stats ? stats.cpu : '...'}
                    </div>
                    {/* progress bar */}
                    <div style={{ height: '4px', background: 'var(--bg-main)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{
                            height: '100%',
                            width: stats ? stats.cpu : '0%',
                            background: stats ? getBarColor(parseFloat(stats.cpu)) : 'var(--bg-main)',
                            transition: 'width 0.5s ease'
                        }} />
                    </div>
                </div>

                {/* RAM usage card */}
                <div className="card">
                    <span className="form-label" style={{ fontSize: '10px', textTransform: 'uppercase' }}>RAM Usage</span>
                    <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0', color: 'var(--text-primary)' }}>
                        {stats ? stats.ram : '...'}
                    </div>
                    <div style={{ height: '4px', background: 'var(--bg-main)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{
                            height: '100%',
                            width: stats ? `${stats.ramPercent}%` : '0%',
                            background: stats ? getBarColor(stats.ramPercent) : 'var(--bg-main)',
                            transition: 'width 0.5s ease'
                        }} />
                    </div>
                </div>

                {/* Disk usage card */}
                <div className="card">
                    <span className="form-label" style={{ fontSize: '10px', textTransform: 'uppercase' }}>Disk Space</span>
                    <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0', color: 'var(--text-primary)' }}>
                        {stats ? stats.disk : '...'}
                    </div>
                    <div style={{ height: '4px', background: 'var(--bg-main)', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{
                            height: '100%',
                            width: stats ? `${stats.diskPercent}%` : '0%',
                            background: stats ? getBarColor(stats.diskPercent) : 'var(--bg-main)',
                            transition: 'width 0.5s ease'
                        }} />
                    </div>
                </div>

                {/* Network latency card */}
                <div className="card">
                    <span className="form-label" style={{ fontSize: '10px', textTransform: 'uppercase' }}>SSH Latency</span>
                    <div style={{ fontSize: '24px', fontWeight: 700, margin: '8px 0', color: 'var(--info)' }}>
                        {stats ? stats.latency : '...'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Uptime: {stats ? stats.uptime : '...'}
                    </div>
                </div>

            </div>

            <div style={{
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px'
            }}>
                <h3 className="h2" style={{ fontSize: '15px' }}>Running Containers ({stats ? stats.containers.length : 0})</h3>
                
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Container Name</th>
                                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status</th>
                                <th style={{ padding: '12px 16px', fontWeight: 600 }}>CPU %</th>
                                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Memory Usage</th>
                                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Disk Usage</th>
                                <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {!stats ? (
                                <tr>
                                    <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                                        Fetching remote container metrics...
                                    </td>
                                </tr>
                            ) : stats.containers.length === 0 ? (
                                <tr>
                                    <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                                        No active Docker containers running on the remote host.
                                    </td>
                                </tr>
                            ) : (
                                stats.containers.map((container, idx) => {
                                    const isUp = container.status.toLowerCase().includes('up');
                                    
                                    return (
                                        <tr key={idx} style={{ borderBottom: '1px solid var(--border-color)', background: idx % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                                            <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                                                {container.name}
                                            </td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span style={{
                                                        width: '6px',
                                                        height: '6px',
                                                        borderRadius: '50%',
                                                        background: isUp ? 'var(--accent)' : 'var(--error)'
                                                    }} />
                                                    <span style={{ color: isUp ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                                        {container.status}
                                                    </span>
                                                </div>
                                            </td>
                                            <td style={{ padding: '12px 16px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                                {container.cpu}
                                            </td>
                                            <td style={{ padding: '12px 16px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                                {container.mem}
                                            </td>
                                            <td style={{ padding: '12px 16px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                                {container.disk || '0B'}
                                            </td>
                                            <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                                                <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                                                    {!isUp ? (
                                                        <button 
                                                            onClick={() => handleRestartContainer(container.name)}
                                                            className="btn btn-secondary" 
                                                            style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--accent)', borderColor: 'var(--accent)' }}
                                                        >
                                                            Start
                                                        </button>
                                                    ) : (
                                                        <button 
                                                            onClick={() => handleStopContainer(container.name)}
                                                            className="btn btn-secondary" 
                                                            style={{ padding: '4px 8px', fontSize: '11px' }}
                                                        >
                                                            Stop
                                                        </button>
                                                    )}
                                                    <button 
                                                        onClick={() => handleRestartContainer(container.name)}
                                                        className="btn btn-secondary" 
                                                        style={{ padding: '4px 8px', fontSize: '11px' }}
                                                    >
                                                        Restart
                                                    </button>
                                                    <button 
                                                        onClick={() => handleDeleteContainer(container.name)}
                                                        className="btn btn-danger" 
                                                        style={{ padding: '4px 8px', fontSize: '11px' }}
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};
