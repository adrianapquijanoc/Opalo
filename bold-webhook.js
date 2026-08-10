// ============================================================================
// Webhook: recibe la confirmación de pago de Bold y te avisa por WhatsApp.
//
// FLUJO:
//   1. Bold confirma un pago → llama a esta URL con los datos de la venta.
//   2. Verificamos que la petición realmente venga de Bold (firma HMAC),
//      para que nadie pueda inventarse una "venta falsa" y hacerte perder
//      tiempo o mostrarte información falsa.
//   3. Buscamos en Upstash el detalle del carrito que guardamos al crear
//      el pago (ver api/bold-signature.js).
//   4. Enviamos un mensaje de plantilla por WhatsApp Cloud API a tu número.
//
// VARIABLES DE ENTORNO QUE NECESITA (Vercel → Settings → Environment Variables):
//   BOLD_SECRET_KEY            → la misma que usa bold-signature.js
//   UPSTASH_REDIS_REST_URL     → igual que en bold-signature.js
//   UPSTASH_REDIS_REST_TOKEN   → igual que en bold-signature.js
//   META_WHATSAPP_TOKEN        → token permanente de tu app de WhatsApp Cloud API (Meta)
//   META_PHONE_NUMBER_ID       → ID del número de WhatsApp Business que envía el aviso
//   MERCHANT_WHATSAPP_NUMBER   → TU número (el que recibe el aviso), formato 573242663138
//   META_TEMPLATE_NAME         → nombre exacto de la plantilla aprobada por Meta
//                                (ver instrucciones más abajo)
//
// CÓMO REGISTRAR ESTA URL EN BOLD:
//   panel.bold.co → Integraciones → Webhooks → Configurar webhook
//   URL: https://tu-proyecto.vercel.app/api/bold-webhook
//
// PLANTILLA DE WHATSAPP QUE DEBES CREAR Y ENVIAR A APROBACIÓN EN META:
//   Nombre sugerido: nueva_venta_opalo
//   Categoría: Utility (utilidad — es una notificación transaccional, no marketing)
//   Idioma: Español (CO)
//   Cuerpo sugerido:
//     "✅ Nueva venta en Ópalo
//      Pedido: {{1}}
//      Producto(s): {{2}}
//      Total: {{3}}"
//   (Meta suele aprobar plantillas de categoría Utility en un par de horas)
//
// IMPORTANTE: esta función necesita el cuerpo "crudo" de la petición (sin
// parsear) para poder validar la firma de Bold correctamente. En Vercel,
// las funciones estilo "Node function" (module.exports) reciben el body
// crudo por defecto si no usas Next.js API routes con bodyParser activado.
// ============================================================================

const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 1) Leer el cuerpo crudo de la petición
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', resolve);
  });

  // 2) Verificar que la petición venga realmente de Bold
  const receivedSignature = req.headers['x-bold-signature'] || '';
  const secretKey = process.env.BOLD_SECRET_KEY || '';
  const encodedBody = Buffer.from(rawBody, 'utf-8').toString('base64');
  const expectedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(encodedBody)
    .digest('hex');

  const isValid =
    receivedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(receivedSignature));

  if (!isValid) {
    res.status(400).json({ error: 'Firma inválida — esta petición no viene de Bold.' });
    return;
  }

  // 3) Responder 200 de inmediato (Bold exige respuesta en menos de 2 segundos)
  res.status(200).json({ received: true });

  // 4) Procesar el evento en segundo plano (ya respondimos a Bold)
  try {
    const event = JSON.parse(rawBody);

    // Solo nos interesan las ventas aprobadas
    if (event.type !== 'SALE_APPROVED') return;

    const data = event.data || {};
    const orderId = data.metadata && data.metadata.reference;
    const totalAmount = data.amount ? data.amount.total : null;
    const paymentMethod = data.payment_method || 'Tarjeta';

    let description = 'Pedido Ópalo (detalle no disponible)';
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (orderId && redisUrl && redisToken) {
      try {
        const r = await fetch(`${redisUrl}/get/order:${encodeURIComponent(orderId)}`, {
          headers: { Authorization: `Bearer ${redisToken}` }
        });
        const j = await r.json();
        if (j && j.result) description = decodeURIComponent(j.result);
      } catch (e) {
        console.error('No se pudo recuperar el detalle del pedido:', e);
      }
    }

    await sendWhatsAppNotification({ orderId, totalAmount, paymentMethod, description });
  } catch (err) {
    console.error('Error procesando el webhook de Bold:', err);
  }
};

async function sendWhatsAppNotification({ orderId, totalAmount, paymentMethod, description }) {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const toNumber = process.env.MERCHANT_WHATSAPP_NUMBER;
  const templateName = process.env.META_TEMPLATE_NAME || 'nueva_venta_opalo';

  if (!token || !phoneNumberId || !toNumber) {
    console.error('Faltan variables de entorno de WhatsApp Cloud API — no se pudo notificar.');
    return;
  }

  const totalFormatted = totalAmount
    ? `$${Number(totalAmount).toLocaleString('es-CO')} COP`
    : 'monto no disponible';

  const body = {
    messaging_product: 'whatsapp',
    to: toNumber,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es_CO' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: orderId || 'sin-referencia' },
            { type: 'text', text: description },
            { type: 'text', text: `${totalFormatted} (${paymentMethod})` }
          ]
        }
      ]
    }
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('WhatsApp Cloud API respondió con error:', errText);
    }
  } catch (e) {
    console.error('No se pudo enviar la notificación de WhatsApp:', e);
  }
}
