// ============================================================================
// Función serverless: genera la "firma de integridad" que exige Bold
// para cada pago con monto fijo, Y guarda temporalmente el detalle del
// carrito (qué productos y cuántos) para que el webhook de confirmación
// pueda recuperarlo — Bold NO envía ese detalle en su notificación de pago,
// solo el monto total y la referencia del pedido.
//
// VARIABLES DE ENTORNO QUE NECESITA (Vercel → Settings → Environment Variables):
//   BOLD_SECRET_KEY               → tu llave secreta de Bold (nunca la compartas)
//   UPSTASH_REDIS_REST_URL        → la consigues creando una base gratis en upstash.com
//   UPSTASH_REDIS_REST_TOKEN      → idem, te la da Upstash al crear la base
//
// IMPORTANTE: pega estos valores SIN comillas en Vercel. Si por accidente
// quedan con comillas ("https://...") esta función las limpia sola (ver
// función cleanEnv más abajo), pero es mejor evitarlo desde el origen.
//
// Si no configuras Upstash, esta función sigue firmando pagos con normalidad
// (el pago funciona igual), simplemente no podrá guardar el detalle del
// carrito y el mensaje de WhatsApp dirá "Pedido Ópalo" en vez del detalle.
// ============================================================================

const crypto = require('crypto');

// Quita comillas simples/dobles que hayan quedado pegadas por error al pegar
// el valor en el panel de variables de entorno, y espacios de más.
function cleanEnv(value) {
  if (!value) return value;
  return value.trim().replace(/^['"]+|['"]+$/g, '');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { orderId, amount, currency, description } = req.body || {};

    if (!orderId || !amount || !currency) {
      res.status(400).json({ error: 'Faltan datos: se requieren orderId, amount y currency.' });
      return;
    }

    const secretKey = cleanEnv(process.env.BOLD_SECRET_KEY);
    if (!secretKey) {
      res.status(500).json({
        error: 'Falta configurar la variable de entorno BOLD_SECRET_KEY en el servidor.'
      });
      return;
    }

    // Bold exige exactamente este orden de concatenación:
    // {Identificador}{Monto}{Divisa}{LlaveSecreta}
    const concatenated = `${orderId}${amount}${currency}${secretKey}`;
    const signature = crypto.createHash('sha256').update(concatenated).digest('hex');

    // Guarda el detalle del carrito por 24h (tiempo máximo que Bold da para pagar)
    // para que el webhook de confirmación pueda recuperarlo por el orderId.
    const redisUrl = cleanEnv(process.env.UPSTASH_REDIS_REST_URL);
    const redisToken = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (description && redisUrl && redisToken) {
      try {
        const r = await fetch(
          `${redisUrl}/set/order:${encodeURIComponent(orderId)}/${encodeURIComponent(description)}?EX=86400`,
          { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` } }
        );
        if (!r.ok) {
          const errText = await r.text();
          console.error('Upstash respondió con error al guardar el pedido:', r.status, errText);
        }
      } catch (e) {
        // No bloqueamos el pago si falla el guardado del detalle
        console.error('No se pudo guardar el detalle del pedido:', e);
      }
    }

    res.status(200).json({ signature });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar la firma de integridad.' });
  }
};
