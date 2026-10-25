'use client';

import { PublicHeader } from '../../components/PublicHeader';
import { FeaturesPage } from '../../views/public/FeaturesPage';
import { PublicFooter } from '../../components/PublicFooter';

export default function Features() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <FeaturesPage />
      </main>
      <PublicFooter />
    </div>
  );
}
