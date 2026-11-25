import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  DEFAULT_PAYMENT_METHODS_CATALOG,
  normalizeComparableText,
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

    const normalizedPattern = normalizeComparableText(pattern);
    const duplicate = uiConfig.catalog.some(
      (m) =>
        normalizeComparableText(m.pattern) === normalizedPattern &&
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
    return {
      ok: true,
      intent: "add_method",
      message: "Método de pago guardado.",
    };
  }

  if (intent === "delete_method") {
    const methodId = String(formData.get("methodId") || "");
    uiConfig.catalog = uiConfig.catalog.filter((m) => m.id !== methodId);
    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return {
      ok: true,
      intent: "delete_method",
      message: "Método eliminado del catálogo.",
    };
  }

  if (intent === "delete_selected") {
    let parsedIds;
    try {
      parsedIds = JSON.parse(String(formData.get("methodIds") || "[]"));
    } catch {
      return {
        ok: false,
        error: "La lista de métodos seleccionados no es válida.",
      };
    }

    if (!Array.isArray(parsedIds) || parsedIds.length === 0) {
      return {
        ok: false,
        error: "Selecciona al menos un método para eliminar.",
      };
    }

    const idsToDelete = new Set(parsedIds.map((id) => String(id)));
    const initialCount = uiConfig.catalog.length;
    uiConfig.catalog = uiConfig.catalog.filter((m) => !idsToDelete.has(m.id));
    const removedCount = initialCount - uiConfig.catalog.length;

    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return {
      ok: true,
      intent: "delete_selected",
      message: `Se eliminaron ${removedCount} método(s) del catálogo.`,
    };
  }

  if (intent === "delete_all") {
    if (formData.get("confirmed") !== "true") {
      return {
        ok: false,
        error: "Debes completar la doble verificación para eliminar todos los métodos.",
      };
    }
    uiConfig.catalog = [];
    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return {
      ok: true,
      intent: "delete_all",
      message: "Se eliminaron todos los métodos del catálogo.",
    };
  }

  if (intent === "load_presets") {
    const existingKeys = new Set(
      uiConfig.catalog.map(
        (m) => `${normalizeComparableText(m.pattern)}::${m.matchType}`,
      ),
    );
    for (const preset of DEFAULT_PAYMENT_METHODS_CATALOG) {
      const key = `${normalizeComparableText(preset.pattern)}::${preset.matchType}`;
      if (!existingKeys.has(key)) {
        uiConfig.catalog.push({ ...preset });
      }
    }
    const saveRes = await saveUiConfig(admin, uiConfig);
    if (!saveRes.ok) {
      return { ok: false, error: saveRes.error };
    }
    return {
      ok: true,
      intent: "load_presets",
      message: "Métodos sugeridos agregados.",
    };
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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleteAllStep, setDeleteAllStep] = useState(0);
  const [deleteAllConfirmedCheck, setDeleteAllConfirmedCheck] = useState(false);

  const isBusy = fetcher.state !== "idle";

  const activeCatalogIds = useMemo(
    () => new Set(catalog.map((m) => m.id)),
    [catalog],
  );

  const validSelectedIds = useMemo(
    () => selectedIds.filter((id) => activeCatalogIds.has(id)),
    [selectedIds, activeCatalogIds],
  );

  const selectedSet = useMemo(
    () => new Set(validSelectedIds),
    [validSelectedIds],
  );

  const allSelected =
    catalog.length > 0 && validSelectedIds.length === catalog.length;

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
      if (fetcher.data.intent === "add_method") {
        setLabel("");
        setPattern("");
      }
      if (
        fetcher.data.intent === "delete_selected" ||
        fetcher.data.intent === "delete_all"
      ) {
        setSelectedIds([]);
        setSelectionMode(false);
        setDeleteAllStep(0);
        setDeleteAllConfirmedCheck(false);
      }
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

  const handleDeleteSelected = () => {
    if (validSelectedIds.length === 0) return;
    const formData = new FormData();
    formData.set("intent", "delete_selected");
    formData.set("methodIds", JSON.stringify(validSelectedIds));
    fetcher.submit(formData, { method: "POST" });
  };

  const handleDeleteAll = () => {
    if (deleteAllStep !== 2 || !deleteAllConfirmedCheck) return;
    const formData = new FormData();
    formData.set("intent", "delete_all");
    formData.set("confirmed", "true");
    fetcher.submit(formData, { method: "POST" });
  };

  const handleLoadPresets = () => {
    const formData = new FormData();
    formData.set("intent", "load_presets");
    fetcher.submit(formData, { method: "POST" });
  };

  const handleToggleOne = (methodId) => {
    setSelectedIds((prev) => {
      const current = prev.filter((id) => activeCatalogIds.has(id));
      return current.includes(methodId)
        ? current.filter((id) => id !== methodId)
        : [...current, methodId];
    });
  };

  const handleToggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : catalog.map((m) => m.id));
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
        en el checkout para reutilizarlos fácilmente al crear reglas. Los métodos
        nativos de Shopify incluyen equivalencia automática español ↔ inglés
        (ignorando mayúsculas y tildes):{" "}
        <code>Depósito bancario</code> ↔ <code>Bank Deposit</code>,{" "}
        <code>Giro postal</code> ↔ <code>Money Order</code>,{" "}
        <code>Pago contra entrega (COD)</code> ↔{" "}
        <code>Cash on Delivery (COD)</code>, <code>Tarjeta de regalo</code> ↔{" "}
        <code>Gift card</code>, <code>Pago diferido</code> ↔{" "}
        <code>Deferred</code> y <code>Pasarela simulada</code> ↔{" "}
        <code>(for testing) Bogus Gateway</code>.
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
          <s-stack direction="block" gap="base">
            {!selectionMode ? (
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-text color="subdued">
                  {catalog.length} método(s) guardado(s)
                </s-text>
                <s-stack direction="inline" gap="small">
                  <s-button
                    variant="secondary"
                    disabled={isBusy || undefined}
                    onClick={() => {
                      setSelectionMode(true);
                      setDeleteAllStep(0);
                      setDeleteAllConfirmedCheck(false);
                    }}
                  >
                    Seleccionar para eliminar
                  </s-button>
                  <s-button
                    variant="secondary"
                    tone="critical"
                    disabled={isBusy || undefined}
                    onClick={() => {
                      setDeleteAllStep(1);
                      setDeleteAllConfirmedCheck(false);
                    }}
                  >
                    Eliminar todos
                  </s-button>
                </s-stack>
              </s-stack>
            ) : (
              <s-box
                padding="base"
                background="subdued"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="inline"
                  gap="base"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-checkbox
                      label={
                        allSelected ? "Deseleccionar todos" : "Seleccionar todos"
                      }
                      checked={allSelected || undefined}
                      onInput={handleToggleSelectAll}
                    />
                    <s-text color="subdued">
                      {validSelectedIds.length} de {catalog.length} seleccionado(s)
                    </s-text>
                  </s-stack>
                  <s-stack direction="inline" gap="small">
                    <s-button
                      variant="primary"
                      tone="critical"
                      loading={isBusy || undefined}
                      disabled={
                        isBusy || validSelectedIds.length === 0 || undefined
                      }
                      onClick={handleDeleteSelected}
                    >
                      Eliminar seleccionados ({validSelectedIds.length})
                    </s-button>
                    <s-button
                      variant="secondary"
                      disabled={isBusy || undefined}
                      onClick={() => {
                        setSelectionMode(false);
                        setSelectedIds([]);
                      }}
                    >
                      Cancelar
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            )}

            {deleteAllStep === 1 && !selectionMode && (
              <s-banner heading="Paso 1 de 2: Verificar eliminación total" tone="warning">
                <s-stack direction="block" gap="small">
                  <s-paragraph>
                    Estás a punto de eliminar los {catalog.length} método(s)
                    guardado(s) del catálogo. Las reglas ya creadas conservarán
                    sus métodos configurados.
                  </s-paragraph>
                  <s-stack direction="inline" gap="small">
                    <s-button
                      variant="primary"
                      tone="critical"
                      disabled={isBusy || undefined}
                      onClick={() => {
                        setDeleteAllStep(2);
                        setDeleteAllConfirmedCheck(false);
                      }}
                    >
                      Continuar
                    </s-button>
                    <s-button
                      variant="secondary"
                      disabled={isBusy || undefined}
                      onClick={() => {
                        setDeleteAllStep(0);
                        setDeleteAllConfirmedCheck(false);
                      }}
                    >
                      Cancelar
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-banner>
            )}

            {deleteAllStep === 2 && !selectionMode && (
              <s-banner heading="Paso 2 de 2: Confirmación definitiva" tone="critical">
                <s-stack direction="block" gap="small">
                  <s-paragraph>
                    Esta acción vaciará el catálogo de métodos guardados y no se
                    puede deshacer. Confirma explícitamente antes de continuar.
                  </s-paragraph>
                  <s-checkbox
                    label={`Sí, confirmo que deseo eliminar todos los (${catalog.length}) métodos guardados`}
                    checked={deleteAllConfirmedCheck || undefined}
                    disabled={isBusy || undefined}
                    onInput={(e) =>
                      setDeleteAllConfirmedCheck(
                        Boolean(e.currentTarget?.checked ?? e.target?.checked)
                      )
                    }
                  />
                  <s-stack direction="inline" gap="small">
                    <s-button
                      variant="primary"
                      tone="critical"
                      loading={isBusy || undefined}
                      disabled={isBusy || !deleteAllConfirmedCheck || undefined}
                      onClick={handleDeleteAll}
                    >
                      Eliminar todos definitivamente
                    </s-button>
                    <s-button
                      variant="secondary"
                      disabled={isBusy || undefined}
                      onClick={() => {
                        setDeleteAllStep(0);
                        setDeleteAllConfirmedCheck(false);
                      }}
                    >
                      Cancelar
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-banner>
            )}

            <s-table variant="auto">
              <s-table-header-row>
                {selectionMode && <s-table-header>Selección</s-table-header>}
                <s-table-header listSlot="primary">Nombre</s-table-header>
                <s-table-header>Texto en checkout</s-table-header>
                <s-table-header>Tipo de coincidencia</s-table-header>
                <s-table-header>Acción</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {catalog.map((method) => (
                  <s-table-row key={method.id}>
                    {selectionMode && (
                      <s-table-cell>
                        <s-checkbox
                          label={`Seleccionar ${method.label}`}
                          labelAccessibilityVisibility="exclusive"
                          checked={selectedSet.has(method.id) || undefined}
                          onInput={() => handleToggleOne(method.id)}
                        />
                      </s-table-cell>
                    )}
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
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
