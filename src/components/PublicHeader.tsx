'use client';

import React, { useState } from 'react';
import { useRouter, Link } from '../router/RouterContext';
import { useAuth } from '../context/AuthContext';
import { contactText } from '../lib/mobile';
import { PWAInstallButton } from './PWAInstallButton';
import { Logo } from './ui/Logo';
import {
  Menu,
  X,
  ArrowRight,
  LogOut,
  LayoutDashboard,
} from 'lucide-react';

export const PublicHeader: React.FC = () => {
  const { pathname } = useRouter();
  const { isAuthenticated, profile, logout, getRedirectPath } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks = [
    { label: 'Home', href: '/' },
    { label: 'Features', href: '/features' },
    { label: 'For societies', href: '/societies' },
    { label: 'For CAs', href: '/accountants' },
    { label: 'Security', href: '/security' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Contact', href: '/contact' },
  ];

  return (
    <header className="sticky top-0 z-40 bg-surface/95 backdrop-blur-md border-b border-border text-fg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand */}
          <Link href="/" className="flex items-center" aria-label="Sahvaas home">
            <Logo size={30} />
          </Link>

          {/* Desktop Navigation Links */}
          <nav className="hidden lg:flex items-center gap-1">
            {navLinks.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    isActive
                      ? 'bg-surface-muted text-brand font-semibold'
                      : 'text-fg hover:text-fg hover:bg-surface-muted/60'
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>

          {/* Right Action Buttons */}
          <div className="hidden sm:flex items-center gap-3">
            <PWAInstallButton />

            {isAuthenticated ? (
              <div className="flex items-center gap-2">
                <Link
                  href={getRedirectPath()}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand text-xs font-semibold shadow-card transition"
                >
                  <LayoutDashboard className="w-3.5 h-3.5" />
                  <span>Go to Workspace</span>
                </Link>

                <button
                  onClick={() => logout()}
                  title="Sign Out"
                  className="p-2 rounded-xl bg-surface-muted hover:bg-border text-fg hover:text-fg transition cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  className="px-3.5 py-2 rounded-lg text-xs font-medium text-fg hover:text-fg hover:bg-surface-muted transition"
                >
                  Sign In
                </Link>

                <Link
                  href="/contact"
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand text-xs font-semibold shadow-card transition"
                >
                  <span>Book Demo</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            )}
          </div>

          {/* Mobile Menu Button */}
          <div className="flex items-center gap-2 lg:hidden">
            <PWAInstallButton />
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 rounded-lg bg-surface-muted text-fg hover:text-fg focus:outline-none"
              aria-label="Toggle Navigation Menu"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Dropdown Menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-border bg-surface/98 px-4 pt-3 pb-6 space-y-2 animate-in slide-in-from-top-2 duration-150">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileMenuOpen(false)}
              className={`block px-3 py-2 rounded-lg text-sm font-medium ${
                pathname === link.href
                  ? 'bg-brand-soft text-brand font-semibold'
                  : 'text-fg hover:bg-surface-muted'
              }`}
            >
              {link.label}
            </Link>
          ))}

          <div className="pt-3 border-t border-border space-y-2">
            {isAuthenticated ? (
              <>
                <Link
                  href={getRedirectPath()}
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand text-on-brand text-xs font-semibold shadow-card"
                >
                  <LayoutDashboard className="w-4 h-4" />
                  <span>Go to Workspace</span>
                </Link>
                <button
                  onClick={() => {
                    logout();
                    setMobileMenuOpen(false);
                  }}
                  className="w-full py-2 rounded-lg text-center text-xs text-danger hover:bg-surface-muted cursor-pointer"
                >
                  Sign Out{contactText(profile) ? ` (${contactText(profile)})` : ''}
                </button>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <Link
                  href="/login"
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full text-center py-2.5 rounded-lg bg-surface-muted text-fg text-xs font-semibold"
                >
                  Sign In
                </Link>
                <Link
                  href="/contact"
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full text-center py-2.5 rounded-lg bg-brand text-on-brand text-xs font-semibold"
                >
                  Book Demo
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
