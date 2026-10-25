'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { OnboardingPage } from '../../views/onboarding/OnboardingPage';

export default function Onboarding() {
  return (
    <ProtectedRoute>
      <OnboardingPage />
    </ProtectedRoute>
  );
}
