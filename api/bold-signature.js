// ============================================================================
// Función serverless: genera la "firma de integridad" que exige Bold
// para cada pago con monto fijo, Y guarda temporalmente el detalle del
// carrito para que el webhook de confirmación pueda recuperarlo.
//
// ⚠️ SEGURIDAD — POR QUÉ EL PRECIO SE CALCULA AQUÍ Y NO EN EL NAVEGADOR:
// El carrito del sitio (opalo.html) vive en JavaScript del navegador, que
// cualquiera puede leer y modificar con las herramientas de desarrollador.
// Si esta función confiara en el monto que le manda el navegador, alguien
// podría pedir que le firmen un pago de $1.000 COP por un producto de
// $1.150.000 COP, y Bold lo cobraría igual (la firma sería "válida" porque
// firmamos lo que nos pidieron, sin verificar si es el precio real).
//
// Por eso esta función NUNCA confía en un monto que venga del navegador.
// En vez de eso, recibe solo QUÉ productos y CUÁNTAS unidades quiere
// comprar el cliente, y ella misma calcula el total usando la lista de
// precios de abajo (PRICES), que solo tú controlas al editar este archivo.
// Si algún día cambias precios en el sitio, TAMBIÉN debes actualizarlos
// aquí, o el cobro real no va a coincidir con lo que se ve en pantalla.
//
// VARIABLES DE ENTORNO QUE NECESITA (Vercel → Settings → Environment Variables):
//   BOLD_SECRET_KEY               → tu llave secreta de Bold (nunca la compartas)
//   UPSTASH_REDIS_REST_URL        → la consigues creando una base gratis en upstash.com
//   UPSTASH_REDIS_REST_TOKEN      → idem, te la da Upstash al crear la base
//
// IMPORTANTE: pega estos valores SIN comillas en Vercel. Si por accidente
// quedan con comillas ("https://...") esta función las limpia sola.
// ============================================================================

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// LISTA OFICIAL DE PRECIOS — la única fuente de verdad para lo que se cobra.
// Debe coincidir con los data-id y data-price de opalo.html / coleccion.html.
// Si agregas un producto nuevo al sitio, agrégalo aquí también.
// ---------------------------------------------------------------------------
const PRICES = {
  bary: 1150000,
  visby: 1150000,
  zadar: 1150000,
  tanta: 1150000,
  lille: 1150000,
  quios: 1150000,
  turin: 1150000,
  ravello: 1150000,
  oslo: 1150000,
  bagcanutillo: 1150000,
  bagdorada: 1150000,
  bagplateada: 1150000,
  bagdegradada: 1150000,
  bagplumanegra: 1150000,
  bagplumaocre: 1150000
};

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
    const { orderId, currency, items } = req.body || {};

    if (!orderId || !currency || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({
        error: 'Faltan datos: se requieren orderId, currency, y una lista de items (id + qty).'
      });
      return;
    }

    // Calculamos el total NOSOTROS, ítem por ítem, contra la lista oficial
    // de precios — ignoramos por completo cualquier precio que venga del cliente.
    let amount = 0;
    const descriptionParts = [];

    for (const item of items) {
      const id = item && item.id;
      const qty = parseInt(item && item.qty, 10);

      if (!id || !PRICES[id]) {
        res.status(400).json({ error: `Producto desconocido: ${id}` });
        return;
      }
      if (!Number.isInteger(qty) || qty <= 0 || qty > 20) {
        res.status(400).json({ error: `Cantidad inválida para ${id}` });
        return;
      }

      amount += PRICES[id] * qty;
      descriptionParts.push(`${qty}x ${id}`);
    }

    const description = descriptionParts.join(', ').slice(0, 100);

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

    // Guarda el detalle del carrito por 24h para que el webhook pueda recuperarlo.
    const redisUrl = cleanEnv(process.env.UPSTASH_REDIS_REST_URL);
    const redisToken = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
    if (redisUrl && redisToken) {
      try {
        const r = await fetch(
          `${redisUrl}/setex/order:${encodeURIComponent(orderId)}/86400/${encodeURIComponent(description)}`,
          { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` } }
        );
        if (!r.ok) {
          const errText = await r.text();
          console.error('Upstash respondió con error al guardar el pedido:', r.status, errText);
        }
      } catch (e) {
        console.error('No se pudo guardar el detalle del pedido:', e);
      }
    }

    // Devolvemos la firma Y el monto real calculado — el navegador debe usar
    // ESTE monto (no el suyo propio) al abrir el checkout de Bold.
    res.status(200).json({ signature, amount, description });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar la firma de integridad.' });
  }
};
