'use client';

import { useParams } from 'next/navigation';
import { ProtectedRoute } from '../../../components/ProtectedRoute';
import { ReceiptPage } from '../../../views/receipt/ReceiptPage';

export default function Receipt() {
  const { id } = useParams<{ id: string }>();
  return (
    <ProtectedRoute>
      <ReceiptPage paymentId={id} />
    </ProtectedRoute>
  );
}
