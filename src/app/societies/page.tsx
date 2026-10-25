'use client';

import { PublicHeader } from '../../components/PublicHeader';
import { SocietiesPage } from '../../views/public/SocietiesPage';
import { PublicFooter } from '../../components/PublicFooter';

export default function Societies() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <SocietiesPage />
      </main>
      <PublicFooter />
    </div>
  );
}
