'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { ResidentDashboardPage } from '../../views/resident/ResidentDashboardPage';

export default function ResidentDashboard() {
  return (
    <ProtectedRoute requiredPortal="resident">
      <ResidentDashboardPage />
    </ProtectedRoute>
  );
}
