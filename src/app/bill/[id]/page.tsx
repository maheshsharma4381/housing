'use client';

import { useParams } from 'next/navigation';
import { ProtectedRoute } from '../../../components/ProtectedRoute';
import { BillPage } from '../../../views/bill/BillPage';

export default function Bill() {
  const { id } = useParams<{ id: string }>();
  return (
    <ProtectedRoute>
      <BillPage billId={id} />
    </ProtectedRoute>
  );
}
