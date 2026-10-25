'use client';

import { PublicHeader } from '../components/PublicHeader';
import { HomePage } from '../views/public/HomePage';
import { PublicFooter } from '../components/PublicFooter';

export default function Page() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <HomePage />
      </main>
      <PublicFooter />
    </div>
  );
}
