import { PublicHeader } from '../../components/PublicHeader';
import { ContactPage } from '../../views/public/ContactPage';
import { PublicFooter } from '../../components/PublicFooter';

export default function Contact() {
  return (
    <div className="flex-1 flex flex-col">
      <PublicHeader />
      <main className="flex-1">
        <ContactPage />
      </main>
      <PublicFooter />
    </div>
  );
}
