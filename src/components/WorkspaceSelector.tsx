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
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs">
        <Building2 className="w-3.5 h-3.5 text-brand shrink-0" />
        <span className="font-semibold text-fg truncate max-w-[200px]">
          {activeSociety.name}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <label className="text-xs uppercase font-semibold text-fg-muted hidden sm:inline">
          Society:
        </label>
        <div className="relative">
          <select
            value={activeSociety?.id || ''}
            onChange={(e) => selectSociety(e.target.value)}
            className="appearance-none bg-surface border border-border-strong hover:border-border-strong rounded-lg px-3 py-1.5 pr-8 text-xs text-fg font-medium outline-none cursor-pointer focus:ring-1 focus:ring-brand"
          >
            {authorizedSocieties.map(({ society, roleBadge }) => (
              <option key={society.id} value={society.id}>
                {society.name} ({roleBadge})
              </option>
            ))}
          </select>
          <ChevronDown className="w-3.5 h-3.5 text-fg-muted absolute right-2.5 top-2.5 pointer-events-none" />
        </div>
      </div>
    </div>
  );
};
