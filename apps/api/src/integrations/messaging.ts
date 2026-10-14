import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

/** SMS (Twilio) and WhatsApp Cloud API. Disabled without credentials; messages are logged instead. */
export function createMessaging(cfg: Config, log: FastifyBaseLogger) {
  const smsOn = !!(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_FROM_NUMBER);
  const waOn = !!(cfg.WHATSAPP_CLOUD_TOKEN && cfg.WHATSAPP_PHONE_NUMBER_ID);
  return {
    smsEnabled: smsOn,
    whatsappEnabled: waOn,
    async sendSms(to: string, body: string) {
      if (!smsOn) {
        log.info({ to }, '[sms:disabled] message logged, not sent');
        return { delivered: false };
      }
      const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: cfg.TWILIO_FROM_NUMBER!, Body: body }),
      });
      return { delivered: res.ok };
    },
    async sendWhatsApp(to: string, body: string) {
      if (!waOn) {
        log.info({ to }, '[whatsapp:disabled] message logged, not sent');
        return { delivered: false };
      }
      const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.WHATSAPP_CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      });
      return { delivered: res.ok };
    },
  };
}
export type Messaging = ReturnType<typeof createMessaging>;
