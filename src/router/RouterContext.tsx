'use client';

import NextLink from 'next/link';
import { useRouter as useNextRouter, usePathname } from 'next/navigation';
import React, { useCallback } from 'react';

/**
 * Adapter ensuring seamless compatibility with Next.js App Router navigation.
 * Query params are intentionally not exposed here: `useSearchParams` forces a
 * Suspense boundary, so pages that need them call it directly.
 */
export function useRouter() {
  const router = useNextRouter();
  const pathname = usePathname();

  const navigate = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      if (options?.replace) {
        router.replace(to);
      } else {
        router.push(to);
      }
    },
    [router]
  );

  return {
    pathname: pathname || '/',
    navigate,
  };
}

export const Link = NextLink;

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <>{children}</>;
};
