import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} compliance webhook for ${shop}`);

  // Esta aplicación no almacena datos personales de clientes.
  // En shop/redact, elimina cualquier sesión residual de la tienda.
  if (topic === "SHOP_REDACT") {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response(null, { status: 200 });
};
