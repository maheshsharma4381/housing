'use client';

import { PublicHeader } from '../../components/PublicHeader';
import { AccountantsPage } from '../../views/public/AccountantsPage';
import { PublicFooter } from '../../components/PublicFooter';

export default function Accountants() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <AccountantsPage />
      </main>
      <PublicFooter />
    </div>
  );
}
