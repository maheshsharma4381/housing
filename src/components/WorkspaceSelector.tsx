'use client';

import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Building2, ChevronDown } from 'lucide-react';

export const WorkspaceSelector: React.FC = () => {
  const { 
    activeSociety, 
    societyMemberships, 
    professionalGrants, 
    selectSociety 
  } = useAuth();

  // Combine authorized societies from memberships and professional grants
  const authorizedSocieties = [
    ...societyMemberships.map(m => ({ 
      society: m.society, 
      roleBadge: m.role.replace('_', ' ') 
    })),
    ...professionalGrants.map(g => ({ 
      society: g.society, 
      roleBadge: `CA / ${g.role.toUpperCase()}` 
    })),
  ];

  // If user only has 0 or 1 society, do not show interactive switcher
  if (authorizedSocieties.length <= 1) {
    if (!activeSociety) return null;
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs">
        <Building2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <span className="font-semibold text-white truncate max-w-[200px]">
          {activeSociety.name}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase font-semibold text-slate-400 hidden sm:inline">
          Society:
        </label>
        <div className="relative">
          <select
            value={activeSociety?.id || ''}
            onChange={(e) => selectSociety(e.target.value)}
            className="appearance-none bg-slate-900 border border-slate-700 hover:border-slate-600 rounded-xl px-3 py-1.5 pr-8 text-xs text-white font-medium outline-none cursor-pointer focus:ring-1 focus:ring-sky-500"
          >
            {authorizedSocieties.map(({ society, roleBadge }) => (
              <option key={society.id} value={society.id}>
                {society.name} ({roleBadge})
              </option>
            ))}
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 pointer-events-none" />
        </div>
      </div>
    </div>
  );
};
