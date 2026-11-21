'use client';

import React from 'react';

export interface TriageUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  color: string;
  isCurrentUser?: boolean;
  lastActive: number;
}

export interface PresenceAvatarsProps {
  users: TriageUser[];
  currentUserId?: string;
  maxDisplay?: number;
}

const AVATAR_COLORS = [
  'bg-emerald-500 ring-emerald-400',
  'bg-cyan-500 ring-cyan-400',
  'bg-purple-500 ring-purple-400',
  'bg-amber-500 ring-amber-400',
  'bg-rose-500 ring-rose-400',
  'bg-indigo-500 ring-indigo-400',
];

export function getInitials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export const PresenceAvatars: React.FC<PresenceAvatarsProps> = ({
  users,
  currentUserId,
  maxDisplay = 5,
}) => {
  const visibleUsers = users.slice(0, maxDisplay);
  const excess = users.length - maxDisplay;

  return (
    <div
      data-testid="presence-avatars"
      className="flex items-center gap-2 bg-[#090b14] border border-white/10 px-3 py-1.5 rounded-full shadow-sm"
    >
      <div className="flex -space-x-2 overflow-hidden items-center">
        {visibleUsers.map((user, idx) => {
          const isCurrent = user.id === currentUserId || user.isCurrentUser;
          const colorClass = AVATAR_COLORS[idx % AVATAR_COLORS.length];

          return (
            <div
              key={user.id}
              className="relative group cursor-pointer"
              title={`${user.name} (${user.email || 'Investigator'})${isCurrent ? ' - You' : ''}`}
            >
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white uppercase ring-2 transition-transform hover:scale-110 hover:z-10 ${colorClass}`}
              >
                {getInitials(user.name)}
              </div>

              {/* Online Green Indicator Dot */}
              <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-[#090b14]" />

              {/* Tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:flex flex-col items-center z-30 pointer-events-none">
                <div className="bg-[#121422] border border-white/10 text-white text-[11px] px-2.5 py-1 rounded-lg shadow-xl whitespace-nowrap">
                  <span className="font-semibold">{user.name}</span>
                  {isCurrent && <span className="text-cyan-400 ml-1">(You)</span>}
                  <div className="text-[10px] text-gray-400">{user.email || 'Online'}</div>
                </div>
                <div className="w-2 h-2 bg-[#121422] rotate-45 border-r border-b border-white/10 -mt-1" />
              </div>
            </div>
          );
        })}

        {excess > 0 && (
          <div
            className="w-7 h-7 rounded-full bg-gray-800 text-gray-300 ring-2 ring-white/10 flex items-center justify-center text-[10px] font-bold"
            title={`${excess} more team members active`}
          >
            +{excess}
          </div>
        )}
      </div>

      <div className="text-[11px] font-medium text-gray-400 pl-1">
        <span className="text-emerald-400 font-bold">{users.length}</span> active
      </div>
    </div>
  );
};
