import { redirect, Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export default function App() {
  const { showForm } = useLoaderData();
  const actionData = useActionData();
  const errors = actionData?.errors;

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Personalización de Métodos de Pago</h1>
        <p className={styles.text}>
          Controla qué métodos de pago se muestran en el checkout de tu tienda
          Shopify según los productos del carrito.
        </p>
        {showForm && (
          <Form className={styles.form} method="post">
            <label className={styles.label}>
              <span>Dominio de la tienda</span>
              <input className={styles.input} type="text" name="shop" />
              <span>{errors?.shop ?? "ej: mi-tienda.myshopify.com"}</span>
            </label>
            <button className={styles.button} type="submit">
              Iniciar sesión
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Reglas dinámicas por carrito</strong>. Evalúa etiquetas,
            colecciones, precio unitario, tipo, proveedor, SKU, título y
            metacampos de producto.
          </li>
          <li>
            <strong>Protección anti-bloqueo</strong>. Si una combinación de
            reglas oculta todas las opciones disponibles, mantiene visibles los
            métodos para no detener la compra.
          </li>
          <li>
            <strong>Catálogo reutilizable de métodos</strong>. Guarda métodos
            personalizados y reconoce equivalencias en español para los métodos
            nativos de Shopify.
          </li>
        </ul>
      </div>
    </div>
  );
}
