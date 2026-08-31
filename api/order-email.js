// ============================================================================
// Función serverless: envía un correo cuando un cliente vuelve a tu sitio
// tras completar un pago con tarjeta en Bold, con el detalle del pedido Y
// los datos de envío (nombre, cédula, celular, dirección, ciudad).
//
// POR QUÉ FUNCIONA SIN UPSTASH:
// Justo antes de abrir la ventana de pago de Bold, el navegador del cliente
// guarda el pedido (temporalmente, en su propio navegador). Cuando Bold
// confirma el pago y lo regresa a tu sitio, Bold agrega automáticamente
// "?bold-order-id=...&bold-tx-status=approved" a la URL. El sitio detecta
// eso, recupera el pedido guardado, y llama a esta función para mandarte
// el correo. No necesitas base de datos.
//
// LIMITACIÓN HONESTA: el estado que llega en la URL es el que el cliente
// vio en su comprobante, pero Bold aclara que "puede no ser el definitivo".
// Para un negocio pequeño esto es más que suficiente, pero si algún día
// quieres blindarlo del todo (a prueba de manipulación), el camino correcto
// es el webhook + Upstash que ya dejamos armado antes — este método es el
// más simple, no el más a prueba de balas.
//
// VARIABLES DE ENTORNO QUE NECESITA (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY   → tu llave de Resend (resend.com → API Keys → Create)
//   NOTIFY_EMAIL     → el correo TUYO donde quieres recibir los avisos
//                      (debe ser el mismo correo con el que te registraste
//                      en Resend, a menos que verifiques un dominio propio)
//
// IMPORTANTE: pega estos valores SIN comillas en Vercel.
// ============================================================================

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
    const { orderId, amount, description, shipping } = req.body || {};

    if (!orderId) {
      res.status(400).json({ error: 'Falta orderId.' });
      return;
    }

    const apiKey = cleanEnv(process.env.RESEND_API_KEY);
    const notifyEmail = cleanEnv(process.env.NOTIFY_EMAIL);

    if (!apiKey || !notifyEmail) {
      res.status(500).json({
        error: 'Falta configurar RESEND_API_KEY o NOTIFY_EMAIL en el servidor.'
      });
      return;
    }

    const totalFormatted = amount
      ? `$${Number(amount).toLocaleString('es-CO')} COP`
      : 'monto no disponible';

    const shippingHtml = shipping
      ? `
        <p><strong>📦 Datos de envío</strong></p>
        <p>
          ${shipping.name || '—'} (CC ${shipping.cedula || '—'})<br>
          📱 ${shipping.phone || '—'}<br>
          📍 ${shipping.address || '—'}, ${shipping.city || '—'}
        </p>`
      : '<p><em>Sin datos de envío.</em></p>';

    const html = `
      <div style="font-family: sans-serif; color:#3B2C22;">
        <h2>✅ Nueva venta en Ópalo</h2>
        <p><strong>Pedido:</strong> ${orderId}</p>
        <p><strong>Producto(s):</strong> ${description || 'sin detalle'}</p>
        <p><strong>Total:</strong> ${totalFormatted}</p>
        ${shippingHtml}
      </div>
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Ópalo <onboarding@resend.dev>',
        to: [notifyEmail],
        subject: `✅ Nueva venta Ópalo — ${orderId}`,
        html
      })
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend respondió con error:', resendRes.status, errText);
      res.status(502).json({ error: 'No se pudo enviar el correo.' });
      return;
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error en order-email:', err);
    res.status(500).json({ error: 'No se pudo procesar el envío del correo.' });
  }
};
