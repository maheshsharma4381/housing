'use client';

import { ProtectedRoute } from '../../components/ProtectedRoute';
import { SetupWizard } from '../../views/setup/SetupWizard';

export default function Setup() {
  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-canvas text-fg py-10 px-4">
        <div className="max-w-2xl mx-auto space-y-6">
          <h1 className="text-2xl font-semibold text-fg tracking-tight">Finish setting up your society</h1>
          <SetupWizard />
        </div>
      </div>
    </ProtectedRoute>
  );
}
