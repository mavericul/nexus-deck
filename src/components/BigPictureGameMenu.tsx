import React, { useEffect, useState } from 'react';
import { Play, ChevronRight, Wifi, WifiOff, Cable, Battery, BatteryCharging, BatteryLow } from 'lucide-react';

export interface SystemStatus {
    has_battery: boolean;
    battery_percent: number;
    is_charging: boolean;
    network_type: 'wifi' | 'ethernet' | 'offline';
    wifi_signal: number;
}

export const BigPictureStatusTray: React.FC<{ status: SystemStatus | null; timeStr: string }> = ({
    status,
    timeStr,
}) => {
    const renderNetworkIcon = () => {
        if (!status || status.network_type === 'offline') {
            return <WifiOff className="w-4 h-4 text-rose-400" />;
        }
        if (status.network_type === 'ethernet') {
            return <Cable className="w-4 h-4 text-slate-200" />;
        }
        return <Wifi className="w-4 h-4 text-slate-200" />;
    };

    const renderBattery = () => {
        if (!status?.has_battery) return null;
        const pct = status.battery_percent;
        return (
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
            {status.is_charging ? (
                <BatteryCharging className="w-4 h-4 text-emerald-400" />
            ) : pct <= 20 ? (
                <BatteryLow className="w-4 h-4 text-rose-400" />
            ) : (
                <Battery className="w-4 h-4 text-emerald-400" />
            )}
            <span>{pct}%</span>
            </div>
        );
    };

    return (
        <div className="flex items-center gap-4 text-slate-200 select-none">
        {renderNetworkIcon()}
        {renderBattery()}
        <span className="text-sm font-semibold tracking-wide tabular-nums">{timeStr}</span>
        </div>
    );
};

interface BigPictureGameMenuProps {
    game: {
        id: string;
        title: string;
        isFavorite?: boolean;
        isInstalled?: boolean;
    };
    focusedColumn: 'main' | 'manage';
    mainIndex: number;
    manageIndex: number;
    onSelectMainIndex: (idx: number) => void;
    onSelectManageIndex: (idx: number) => void;
    onAction: (action: 'play' | 'favorite' | 'properties' | 'hide' | 'uninstall' | 'close') => void;
}

export const BigPictureGameMenu: React.FC<BigPictureGameMenuProps> = ({
    game,
    focusedColumn,
    mainIndex,
    manageIndex,
    onSelectMainIndex,
    onSelectManageIndex,
    onAction,
}) => {
    const mainItems = [
        { id: 'play', label: 'Play', icon: <Play className="w-3.5 h-3.5 fill-current" />, hasSubmenu: false },
        { id: 'favorite', label: game.isFavorite ? 'Remove from Favorites' : 'Add to Favorites', hasSubmenu: false },
        { id: 'manage', label: 'Manage', hasSubmenu: true },
        { id: 'properties', label: 'Properties...', hasSubmenu: false },
        { id: 'close', label: 'Cancel', hasSubmenu: false },
    ] as const;

    const manageItems = [
        { id: 'hide', label: 'Hide this game' },
        { id: 'properties', label: 'Controller & Launch Options' },
        { id: 'uninstall', label: 'Uninstall', danger: true },
    ] as const;

    const showManageSubmenu = mainItems[mainIndex]?.id === 'manage';

    return (
        <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md animate-fadeIn"
        onClick={() => onAction('close')}
        >
        {/* Container meniu tip Steam Big Picture */}
        <div
        className="relative flex items-start"
        onClick={(e) => e.stopPropagation()}
        >
        {/* Coloana principală */}
        <div className="w-72 bg-[#1b2028]/95 border border-white/10 shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-white/10 text-xs uppercase tracking-wider text-slate-400 truncate">
        {game.title}
        </div>

        <div className="py-1">
        {mainItems.map((item, idx) => {
            const isSelected = mainIndex === idx;
            const isPrimaryFocus = isSelected && focusedColumn === 'main';
            const isSecondaryFocus = isSelected && focusedColumn === 'manage';

        return (
            <button
            key={item.id}
            onMouseEnter={() => onSelectMainIndex(idx)}
            onClick={() => {
                if (item.id === 'manage') return;
                onAction(item.id);
            }}
            className={`w-full flex items-center justify-between px-5 py-3.5 text-left text-[15px] transition-colors duration-100 ${
                isPrimaryFocus
                ? 'bg-white text-slate-950 font-semibold'
                : isSecondaryFocus
                ? 'bg-white/20 text-white font-medium'
                : 'text-slate-200 hover:bg-white/10'
            }`}
            >
            <span className="flex items-center gap-2.5">
            {'icon' in item && item.icon}
            {item.label}
            </span>
            {item.hasSubmenu && (
                <ChevronRight
                className={`w-4 h-4 ${isPrimaryFocus ? 'text-slate-900' : 'text-slate-400'}`}
                />
            )}
            </button>
        );
        })}
        </div>
        </div>

        {/* Submeniu lateral pentru Manage */}
        {showManageSubmenu && (
            <div className="w-64 bg-[#232933]/95 border border-l-0 border-white/10 shadow-2xl mt-[126px]">
            <div className="py-1">
            {manageItems.map((sub, sIdx) => {
                const isSubFocused = focusedColumn === 'manage' && manageIndex === sIdx;
                return (
                    <button
                    key={sub.id}
                    onMouseEnter={() => onSelectManageIndex(sIdx)}
                    onClick={() => onAction(sub.id)}
                    className={`w-full flex items-center justify-between px-5 py-3.5 text-left text-[15px] transition-colors duration-100 ${
                        isSubFocused
                        ? 'bg-white text-slate-950 font-semibold'
                : 'danger' in sub && sub.danger
                ? 'text-rose-400 hover:bg-white/10'
                : 'text-slate-200 hover:bg-white/10'
                    }`}
                    >
                    <span>{sub.label}</span>
                    </button>
                );
            })}
            </div>
            </div>
        )}
        </div>

        {/* Footer indicatoare controller (dreapta jos, stil Steam) */}
        <div className="fixed bottom-6 right-8 flex items-center gap-6 text-xs font-bold tracking-wider text-slate-200">
        <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-white text-slate-950 flex items-center justify-center font-extrabold shadow">
        A
        </span>
        <span>SELECT</span>
        </div>
        <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-white text-slate-950 flex items-center justify-center font-extrabold shadow">
        B
        </span>
        <span>BACK</span>
        </div>
        </div>
        </div>
    );
};
