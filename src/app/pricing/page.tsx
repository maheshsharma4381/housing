import { PublicHeader } from '../../components/PublicHeader';
import { PricingPage } from '../../views/public/PricingPage';
import { PublicFooter } from '../../components/PublicFooter';

export default function Pricing() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <PricingPage />
      </main>
      <PublicFooter />
    </div>
  );
}
