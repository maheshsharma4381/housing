'use client';

import { useParams } from 'next/navigation';
import { JoinPage } from '../../../views/join/JoinPage';

export default function Join() {
  const { code } = useParams<{ code: string }>();
  return <JoinPage code={code} />;
}
