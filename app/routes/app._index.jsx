import { useEffect, useMemo } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  formatRuleSummary,
  MAX_LIST_VAR_ITEMS,
  MAX_METAFIELD_SLOTS,
  MAX_RULES_CONFIG_BYTES,
  SAMPLE_RULE_TEMPLATES,
} from "../lib/payment-rules";
import {
  loadPaymentFilterState,
  saveUiConfig,
  setCustomizationEnabled,
} from "../services/payment-customization.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  return loadPaymentFilterState(admin);
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const state = await loadPaymentFilterState(admin);
  const uiConfig = structuredClone(state.uiConfig);

  if (intent === "initialize") {
    const res = await saveUiConfig(admin, uiConfig, { enabled: true });
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return {
      ok: true,
      message: "Personalización de pagos activada en el checkout.",
    };
  }

  if (intent === "toggle_customization") {
    if (!state.customization) {
      const res = await saveUiConfig(admin, uiConfig, { enabled: true });
      if (!res.ok) {
        return { ok: false, error: res.error };
      }
      return {
        ok: true,
        message: "Personalización creada y activada en el checkout.",
      };
    }

    const nextEnabled = !state.customization.enabled;
    const res = await setCustomizationEnabled(
      admin,
      state.customization.id,
      nextEnabled,
    );
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return {
      ok: true,
      message: nextEnabled
        ? "Personalización activada en el checkout."
        : "Personalización pausada en el checkout.",
    };
  }

  if (intent === "toggle_failsafe") {
    uiConfig.failSafe = !uiConfig.failSafe;
    const res = await saveUiConfig(admin, uiConfig);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return {
      ok: true,
      message: uiConfig.failSafe
        ? "Protección anti-bloqueo activada."
        : "Protección anti-bloqueo desactivada.",
    };
  }

  if (intent === "toggle_rule") {
    const ruleId = String(formData.get("ruleId") || "");
    const target = uiConfig.rules.find((r) => r.id === ruleId);
    if (!target) {
      return { ok: false, error: "No se encontró la regla seleccionada." };
    }
    target.enabled = !target.enabled;
    const res = await saveUiConfig(admin, uiConfig);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return {
      ok: true,
      message: target.enabled ? "Regla activada." : "Regla pausada.",
    };
  }

  if (intent === "duplicate_rule") {
    const ruleId = String(formData.get("ruleId") || "");
    const source = uiConfig.rules.find((r) => r.id === ruleId);
    if (!source) {
      return { ok: false, error: "No se encontró la regla a duplicar." };
    }
    const copy = structuredClone(source);
    copy.id = `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    copy.name = `${source.name} (copia)`;
    copy.conditions = copy.conditions.map((c, idx) => ({
      ...c,
      id: `cond-${Date.now().toString(36)}-${idx}`,
    }));
    uiConfig.rules.push(copy);

    let res = await saveUiConfig(admin, uiConfig);
    if (!res.ok && copy.enabled) {
      copy.enabled = false;
      res = await saveUiConfig(admin, uiConfig);
      if (res.ok) {
        return {
          ok: true,
          message:
            "Regla duplicada en estado pausado para respetar los límites activos de Shopify.",
        };
      }
    }
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, message: "Regla duplicada." };
  }

  if (intent === "delete_rule") {
    const ruleId = String(formData.get("ruleId") || "");
    uiConfig.rules = uiConfig.rules.filter((r) => r.id !== ruleId);
    const res = await saveUiConfig(admin, uiConfig);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return { ok: true, message: "Regla eliminada." };
  }

  if (intent === "apply_templates") {
    const existingIds = new Set(uiConfig.rules.map((r) => r.id));
    for (const tpl of SAMPLE_RULE_TEMPLATES) {
      if (!existingIds.has(tpl.id)) {
        uiConfig.rules.push(structuredClone(tpl));
      }
    }
    const res = await saveUiConfig(admin, uiConfig);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    return {
      ok: true,
      message: "Reglas de ejemplo cargadas y sincronizadas.",
    };
  }

  return { ok: false, error: "Acción no reconocida." };
};

export default function PaymentRulesDashboard() {
  const {
    customization,
    functionDeployed,
    uiConfig,
    metrics,
    storeCatalog,
    metadataWarning,
  } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const isBusy = fetcher.state !== "idle";

  const collectionsById = useMemo(() => {
    const map = {};
    for (const col of storeCatalog?.collections || []) {
      map[col.id] = col.title;
    }
    return map;
  }, [storeCatalog?.collections]);

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const submitIntent = (intent, extra = {}) => {
    const formData = new FormData();
    formData.set("intent", intent);
    for (const [k, v] of Object.entries(extra)) {
      formData.set(k, String(v));
    }
    fetcher.submit(formData, { method: "POST" });
  };

  const activeRulesCount = uiConfig.rules.filter((r) => r.enabled).length;
  const activeMetafields = metrics?.activeMetafields || [];

  return (
    <s-page heading="Reglas de métodos de pago" inlineSize="base">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate("/app/rules/new")}
      >
        Nueva regla
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => navigate("/app/methods")}
      >
        Métodos de pago ({uiConfig.catalog.length})
      </s-button>

      {!functionDeployed && (
        <s-banner
          heading="Extensión de checkout pendiente"
          tone="warning"
        >
          No se detectó la Shopify Function de personalización de pagos en esta
          tienda. Ejecuta `shopify app dev` o despliega la extensión para
          activar las reglas en el checkout.
        </s-banner>
      )}

      {fetcher.data?.error && (
        <s-banner heading="No se pudo completar la acción" tone="critical">
          {fetcher.data.error}
        </s-banner>
      )}

      {metadataWarning && (
        <s-banner heading="Aviso al leer catálogo de tienda" tone="warning">
          {metadataWarning}
        </s-banner>
      )}

      <s-section heading="Estado en el checkout">
        <s-stack direction="block" gap="base">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-stack direction="inline" gap="small" alignItems="center">
              {!customization ? (
                <s-badge tone="warning">Sin inicializar</s-badge>
              ) : customization.enabled ? (
                <s-badge tone="success">Activa en checkout</s-badge>
              ) : (
                <s-badge tone="neutral">Pausada</s-badge>
              )}
              <s-text color="subdued">
                {activeRulesCount} de {uiConfig.rules.length} regla(s) activa(s)
              </s-text>
            </s-stack>

            <s-button
              variant={customization?.enabled ? "secondary" : "primary"}
              disabled={isBusy || undefined}
              onClick={() =>
                submitIntent(
                  customization ? "toggle_customization" : "initialize",
                )
              }
            >
              {!customization
                ? "Activar personalización"
                : customization.enabled
                  ? "Pausar en checkout"
                  : "Activar en checkout"}
            </s-button>
          </s-stack>

          <s-divider />

          <s-switch
            label="Protección anti-bloqueo (recomendado)"
            details="Si la combinación de reglas llegara a ocultar todos los métodos de pago disponibles, Shopify mostrará todos los métodos para evitar bloquear la compra."
            checked={uiConfig.failSafe || undefined}
            disabled={isBusy || undefined}
            onInput={() => submitIntent("toggle_failsafe")}
          />
        </s-stack>
      </s-section>

      <s-section heading="Reglas configuradas">
        {uiConfig.rules.length === 0 ? (
          <s-box
            padding="large"
            background="subdued"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="base">
              <s-heading>Aún no hay reglas creadas</s-heading>
              <s-paragraph>
                Crea reglas para ocultar o restringir métodos de pago según
                etiquetas, colecciones, tipo, proveedor, SKU, título o
                metacampos de los productos en el carrito.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  onClick={() => navigate("/app/rules/new")}
                >
                  Crear primera regla
                </s-button>
                <s-button
                  variant="secondary"
                  disabled={isBusy || undefined}
                  onClick={() => submitIntent("apply_templates")}
                >
                  Cargar reglas de ejemplo (reacondicionado y servicio-tecnico)
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Regla</s-table-header>
              <s-table-header>Acción</s-table-header>
              <s-table-header>Estado</s-table-header>
              <s-table-header>Acciones</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {uiConfig.rules.map((rule) => (
                <s-table-row key={rule.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">{rule.name}</s-text>
                      <s-text color="subdued">
                        {formatRuleSummary(rule, collectionsById)}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-badge
                        tone={
                          rule.action === "allow_only_selected"
                            ? "info"
                            : "warning"
                        }
                      >
                        {rule.action === "allow_only_selected"
                          ? "Mostrar solo"
                          : "Ocultar"}
                      </s-badge>
                      <s-text color="subdued">
                        {(rule.targets || [])
                          .map((t) => t.label || t.pattern)
                          .join(", ")}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={rule.enabled ? "success" : "neutral"}>
                      {rule.enabled ? "Activa" : "Pausada"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      <s-button
                        variant="tertiary"
                        onClick={() => navigate(`/app/rules/${rule.id}`)}
                      >
                        Editar
                      </s-button>
                      <s-button
                        variant="tertiary"
                        disabled={isBusy || undefined}
                        onClick={() =>
                          submitIntent("toggle_rule", { ruleId: rule.id })
                        }
                      >
                        {rule.enabled ? "Pausar" : "Activar"}
                      </s-button>
                      <s-button
                        variant="tertiary"
                        disabled={isBusy || undefined}
                        onClick={() =>
                          submitIntent("duplicate_rule", { ruleId: rule.id })
                        }
                      >
                        Duplicar
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        disabled={isBusy || undefined}
                        onClick={() =>
                          submitIntent("delete_rule", { ruleId: rule.id })
                        }
                      >
                        Eliminar
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Uso de Shopify Function">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            <s-text type="strong">Tamaño configuración: </s-text>
            <s-text>
              {metrics?.rulesConfigBytes || 0} / {MAX_RULES_CONFIG_BYTES} bytes
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Metacampos activos: </s-text>
            <s-text>
              {activeMetafields.length} / {MAX_METAFIELD_SLOTS} espacios
            </s-text>
          </s-paragraph>
          {activeMetafields.length > 0 && (
            <s-unordered-list>
              {activeMetafields.map((mf) => (
                <s-list-item key={`${mf.namespace}.${mf.key}`}>
                  <code>
                    {mf.namespace}.{mf.key}
                  </code>
                </s-list-item>
              ))}
            </s-unordered-list>
          )}
          <s-paragraph>
            <s-text type="strong">Etiquetas vigiladas: </s-text>
            <s-text>
              {metrics?.watchedTagsCount || 0} / {MAX_LIST_VAR_ITEMS}
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Colecciones vigiladas: </s-text>
            <s-text>
              {metrics?.watchedCollectionsCount || 0} / {MAX_LIST_VAR_ITEMS}
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Cómo se combinan las reglas">
        <s-paragraph>
          Las reglas activas se evalúan de forma <s-text type="strong">acumulativa</s-text>: si un carrito activa varias reglas a la vez, cualquier método ocultado o excluido por al menos una regla quedará oculto en el checkout.
        </s-paragraph>
        <s-paragraph>
          Configura los nombres de métodos de pago usados en tu checkout desde{" "}
          <s-link href="/app/methods">Métodos de pago</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
