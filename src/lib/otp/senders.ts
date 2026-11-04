// Who delivers a login code: WhatsApp Cloud API first, MSG91 SMS as the Indian backup,
// and in development only a console line. Pure builders: the route does the fetch.

export interface WhatsAppConfig { token: string; phoneNumberId: string; template: string; lang: string }
export interface Msg91Config { authKey: string; templateId: string }
export interface OtpConfig {
  provider: 'whatsapp' | 'console' | 'none';
  whatsapp: WhatsAppConfig | null;
  msg91: Msg91Config | null;
}

type Env = Record<string, string | undefined>;

export function otpConfig(env: Env): OtpConfig {
  const whatsapp = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TEMPLATE_NAME
    ? { token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, template: env.WHATSAPP_TEMPLATE_NAME, lang: env.WHATSAPP_TEMPLATE_LANG || 'en' }
    : null;
  const msg91 = env.MSG91_AUTH_KEY && env.MSG91_TEMPLATE_ID ? { authKey: env.MSG91_AUTH_KEY, templateId: env.MSG91_TEMPLATE_ID } : null;
  const production = env.NODE_ENV === 'production';
  const wanted = env.OTP_PROVIDER || (whatsapp ? 'whatsapp' : 'console');
  let provider: OtpConfig['provider'] = 'none';
  if (wanted === 'whatsapp' && whatsapp) provider = 'whatsapp';
  // A code in the server log is fine on a laptop and never in production
  else if (wanted === 'console' && !production) provider = 'console';
  return { provider, whatsapp, msg91 };
}

export const isIndianMobile = (to: string) => to.length === 12 && to.startsWith('91');
export const maskMobile = (to: string) => `${to.slice(0, 2)}${'*'.repeat(Math.max(0, to.length - 6))}${to.slice(-4)}`;

/** An authentication template: the code in the body and in the copy-code button. */
export function whatsappRequest(cfg: WhatsAppConfig, to: string, code: string): { url: string; init: RequestInit } {
  return {
    url: `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: cfg.template,
          language: { code: cfg.lang },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
    },
  };
}

/** MSG91's OTP API with our own code (a DLT-approved template is needed). */
export function msg91Request(cfg: Msg91Config, to: string, code: string): { url: string; init: RequestInit } {
  const q = new URLSearchParams({ template_id: cfg.templateId, mobile: to, otp: code });
  return {
    url: `https://control.msg91.com/api/v5/otp?${q.toString()}`,
    init: { method: 'POST', headers: { authkey: cfg.authKey, 'Content-Type': 'application/json' } },
  };
}
