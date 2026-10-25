'use client';

import { Suspense } from 'react';
import { LoginPage } from '../../views/public/LoginPage';

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginPage />
    </Suspense>
  );
}
