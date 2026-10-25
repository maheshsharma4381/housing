'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { ProfessionalDashboardPage } from '../../views/professional/ProfessionalDashboardPage';

export default function ProfessionalDashboard() {
  return (
    <ProtectedRoute requiredPortal="professional">
      <ProfessionalDashboardPage />
    </ProtectedRoute>
  );
}
