'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { SocietyDashboardPage } from '../../views/society/SocietyDashboardPage';

export default function SocietyDashboard() {
  return (
    <ProtectedRoute requiredPortal="society">
      <SocietyDashboardPage />
    </ProtectedRoute>
  );
}
