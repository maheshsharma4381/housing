'use client';

import { Suspense } from 'react';
import { SignupPage } from '../../views/public/SignupPage';

export default function Signup() {
  return (
    <Suspense fallback={null}>
      <SignupPage />
    </Suspense>
  );
}
