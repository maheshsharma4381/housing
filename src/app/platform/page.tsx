'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { PlatformDashboardPage } from '../../views/platform/PlatformDashboardPage';

export default function PlatformDashboard() {
  return (
    <ProtectedRoute requiredPortal="platform">
      <PlatformDashboardPage />
    </ProtectedRoute>
  );
}
