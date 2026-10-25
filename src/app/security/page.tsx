import { PublicHeader } from '../../components/PublicHeader';
import { SecurityPage } from '../../views/public/SecurityPage';
import { PublicFooter } from '../../components/PublicFooter';

export default function Security() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <SecurityPage />
      </main>
      <PublicFooter />
    </div>
  );
}
