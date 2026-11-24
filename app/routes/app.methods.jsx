import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_PAYMENT_METHODS_CATALOG,
  validateCatalogMethod,
} from "../lib/payment-rules";
import {
  loadPaymentFilterState,
  saveUiConfig,
} from "../services/payment-customization.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const state = await loadPaymentFilterState(admin);
  return {
    catalog: state.uiConfig.catalog,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const state = await loadPaymentFilterState(admin);
  const uiConfig = structuredClone(state.uiConfig);

  if (intent === "add_method") {
    const label = String(formData.get("label") || "").trim();
    const pattern = String(formData.get("pattern") || "").trim();
    const matchType =
      formData.get("matchType") === "exact" ? "exact" : "contains";

    const validation = validateCatalogMethod({ label, pattern });
    if (!validation.valid) {
      return {
        ok: false,
        error: "Completa el nombre visible y el texto de coincidencia.",
        fieldErrors: validation.errors,
      };
    }

    const duplicate = uiConfig.catalog.some(
      (m) =>
        m.pattern.trim().toLowerCase() === pattern.toLowerCase() &&
        m.matchType === matchType,
    );
    if (duplicate) {
      return {
        ok: false,
        error: "Ya existe un método guardado con ese texto y tipo de coincidencia.",
      };
    }

    uiConfig.catalog.push({
      id: `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      pattern,
      matchType,
    });

    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return { ok: true, message: "Método de pago guardado." };
  }

  if (intent === "delete_method") {
    const methodId = String(formData.get("methodId") || "");
    uiConfig.catalog = uiConfig.catalog.filter((m) => m.id !== methodId);
    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return { ok: true, message: "Método eliminado del catálogo." };
  }

  if (intent === "load_presets") {
    const existingKeys = new Set(
      uiConfig.catalog.map(
        (m) => `${m.pattern.trim().toLowerCase()}::${m.matchType}`,
      ),
    );
    for (const preset of DEFAULT_PAYMENT_METHODS_CATALOG) {
      const key = `${preset.pattern.trim().toLowerCase()}::${preset.matchType}`;
      if (!existingKeys.has(key)) {
        uiConfig.catalog.push({ ...preset });
      }
    }
    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return { ok: true, message: "Métodos sugeridos agregados." };
  }

  return { ok: false, error: "Acción no reconocida." };
};

export default function PaymentMethodsCatalogPage() {
  const { catalog } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [label, setLabel] = useState("");
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState("contains");

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
      setLabel("");
      setPattern("");
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleAdd = () => {
    const formData = new FormData();
    formData.set("intent", "add_method");
    formData.set("label", label);
    formData.set("pattern", pattern);
    formData.set("matchType", matchType);
    fetcher.submit(formData, { method: "POST" });
  };

  const handleDelete = (methodId) => {
    const formData = new FormData();
    formData.set("intent", "delete_method");
    formData.set("methodId", methodId);
    fetcher.submit(formData, { method: "POST" });
  };

  const handleLoadPresets = () => {
    const formData = new FormData();
    formData.set("intent", "load_presets");
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <s-page heading="Catálogo de métodos de pago" inlineSize="base">
      <s-button
        slot="secondary-actions"
        disabled={isBusy || undefined}
        onClick={handleLoadPresets}
      >
        Restaurar sugeridos
      </s-button>

      <s-banner heading="Cómo se vinculan los métodos de pago" tone="info">
        Shopify no expone la lista de métodos activos del checkout por Admin API.
        Guarda aquí los nombres (o palabras clave) tal como los ven tus clientes
        en el checkout para reutilizarlos fácilmente al crear reglas.
      </s-banner>

      {fetcher.data?.error && (
        <s-banner heading="No se pudo guardar" tone="critical">
          {fetcher.data.error}
        </s-banner>
      )}

      <s-section heading="Agregar método de pago">
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="1fr 1fr 180px auto"
            gap="base"
            alignItems="end"
          >
            <s-text-field
              label="Nombre interno"
              placeholder="Ej: Transferencia directa"
              value={label}
              error={fetcher.data?.fieldErrors?.label || undefined}
              onInput={(e) => setLabel(e.currentTarget.value)}
            />
            <s-text-field
              label="Texto en checkout"
              placeholder="Ej: transferencia directa"
              value={pattern}
              error={fetcher.data?.fieldErrors?.pattern || undefined}
              onInput={(e) => setPattern(e.currentTarget.value)}
            />
            <s-select
              label="Coincidencia"
              value={matchType}
              onInput={(e) =>
                setMatchType(
                  e.currentTarget.value === "exact" ? "exact" : "contains",
                )
              }
            >
              <s-option value="contains">Contiene texto</s-option>
              <s-option value="exact">Nombre exacto</s-option>
            </s-select>
            <s-button
              variant="primary"
              loading={isBusy || undefined}
              onClick={handleAdd}
            >
              Guardar
            </s-button>
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Métodos guardados">
        {catalog.length === 0 ? (
          <s-box
            padding="large"
            background="subdued"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Aún no tienes métodos guardados en tu catálogo.
              </s-paragraph>
              <s-button
                variant="secondary"
                disabled={isBusy || undefined}
                onClick={handleLoadPresets}
              >
                Cargar métodos sugeridos
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Nombre</s-table-header>
              <s-table-header>Texto en checkout</s-table-header>
              <s-table-header>Tipo de coincidencia</s-table-header>
              <s-table-header>Acción</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {catalog.map((method) => (
                <s-table-row key={method.id}>
                  <s-table-cell>
                    <s-text type="strong">{method.label}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <code>{method.pattern}</code>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={method.matchType === "exact" ? "info" : "neutral"}
                    >
                      {method.matchType === "exact" ? "Exacto" : "Contiene"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={isBusy || undefined}
                      onClick={() => handleDelete(method.id)}
                    >
                      Eliminar
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
