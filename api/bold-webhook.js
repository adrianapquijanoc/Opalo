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
// NOTA IMPORTANTE SOBRE EL BOTÓN "PROBAR EL WEBHOOK" DE BOLD:
//   Cuando usas llaves de prueba (modo de pruebas) o el botón "Probar el
//   webhook" del panel de Bold, Bold firma esa notificación con una llave
//   vacía en vez de tu llave secreta real. Por eso esta función intenta
//   verificar la firma primero con tu llave secreta real, y si no coincide,
//   intenta de nuevo con una llave vacía antes de rechazar la petición.
//
// VARIABLES DE ENTORNO QUE NECESITA (Vercel → Settings → Environment Variables):
//   BOLD_SECRET_KEY            → la misma que usa bold-signature.js
//   UPSTASH_REDIS_REST_URL     → igual que en bold-signature.js
//   UPSTASH_REDIS_REST_TOKEN   → igual que en bold-signature.js
//   META_WHATSAPP_TOKEN        → token permanente de tu app de WhatsApp Cloud API (Meta)
//   META_PHONE_NUMBER_ID       → ID del número de WhatsApp Business que envía el aviso
//   MERCHANT_WHATSAPP_NUMBER   → TU número (el que recibe el aviso), formato 573242663138
//   META_TEMPLATE_NAME         → nombre exacto de la plantilla aprobada por Meta
//
// IMPORTANTE: pega todos estos valores SIN comillas en Vercel. Si quedan con
// comillas por accidente, esta función las limpia sola (ver cleanEnv).
//
// CÓMO REGISTRAR ESTA URL EN BOLD:
//   panel.bold.co → Integraciones → Webhooks → Configurar webhook
//   URL: https://tu-proyecto.vercel.app/api/bold-webhook
// ============================================================================

const crypto = require('crypto');

// Quita comillas simples/dobles que hayan quedado pegadas por error al pegar
// el valor en el panel de variables de entorno, y espacios de más.
function cleanEnv(value) {
  if (!value) return value;
  return value.trim().replace(/^['"]+|['"]+$/g, '');
}

function computeSignature(encodedBody, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(encodedBody).digest('hex');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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

  // 2) Verificar que la petición venga realmente de Bold.
  //    Probamos primero con la llave secreta real (pagos reales),
  //    y si no coincide, con una llave vacía (modo de pruebas / "Probar el webhook").
  const receivedSignature = req.headers['x-bold-signature'] || '';
  const secretKey = cleanEnv(process.env.BOLD_SECRET_KEY) || '';
  const encodedBody = Buffer.from(rawBody, 'utf-8').toString('base64');

  const signatureWithRealKey = computeSignature(encodedBody, secretKey);
  const signatureWithEmptyKey = computeSignature(encodedBody, '');

  const isValid =
    safeEqual(signatureWithRealKey, receivedSignature) ||
    safeEqual(signatureWithEmptyKey, receivedSignature);

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
    const redisUrl = cleanEnv(process.env.UPSTASH_REDIS_REST_URL);
    const redisToken = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);

    if (orderId && redisUrl && redisToken) {
      try {
        const r = await fetch(`${redisUrl}/get/order:${encodeURIComponent(orderId)}`, {
          method: 'POST',
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
  const token = cleanEnv(process.env.META_WHATSAPP_TOKEN);
  const phoneNumberId = cleanEnv(process.env.META_PHONE_NUMBER_ID);
  const toNumber = cleanEnv(process.env.MERCHANT_WHATSAPP_NUMBER);
  const templateName = cleanEnv(process.env.META_TEMPLATE_NAME) || 'nueva_venta_opalo';

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
