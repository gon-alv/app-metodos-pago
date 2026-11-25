import { useEffect, useMemo, useState } from "react";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  CONDITION_FIELDS,
  createEmptyCondition,
  createEmptyRule,
  formatRuleSummary,
  MAX_METAFIELD_SLOTS,
  normalizeComparableText,
  normalizeRule,
  OPERATOR_LABELS,
  OPERATORS_BY_FIELD,
  validateCatalogMethod,
  validateRule,
  VALUELESS_OPERATORS,
} from "../lib/payment-rules";
import {
  loadPaymentFilterState,
  saveUiConfig,
} from "../services/payment-customization.server";

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const state = await loadPaymentFilterState(admin);
  const ruleId = params.ruleId;

  if (ruleId === "new") {
    return {
      isNew: true,
      notFound: false,
      initialRule: createEmptyRule(),
      uiConfig: state.uiConfig,
      metrics: state.metrics,
      storeCatalog: state.storeCatalog,
    };
  }

  const found = state.uiConfig.rules.find((r) => r.id === ruleId);
  if (!found) {
    return {
      isNew: false,
      notFound: true,
      initialRule: null,
      uiConfig: state.uiConfig,
      metrics: state.metrics,
      storeCatalog: state.storeCatalog,
    };
  }

  return {
    isNew: false,
    notFound: false,
    initialRule: found,
    uiConfig: state.uiConfig,
    metrics: state.metrics,
    storeCatalog: state.storeCatalog,
  };
};

export const action = async ({ request, params }) => {
  const { admin, redirect } = await authenticate.admin(request);
  const formData = await request.formData();

  let parsedRule;
  let parsedExtraCatalog = [];
  try {
    parsedRule = JSON.parse(String(formData.get("rulePayload") || "{}"));
    parsedExtraCatalog = JSON.parse(
      String(formData.get("extraCatalogPayload") || "[]"),
    );
  } catch {
    return {
      ok: false,
      error: "Los datos enviados de la regla no tienen un formato válido.",
    };
  }

  const normalizedRule = normalizeRule(parsedRule);
  const validation = validateRule(normalizedRule);
  if (!validation.valid) {
    return {
      ok: false,
      error: "Revisa los campos obligatorios antes de guardar la regla.",
      fieldErrors: validation.errors,
    };
  }

  const state = await loadPaymentFilterState(admin);
  const uiConfig = structuredClone(state.uiConfig);

  if (Array.isArray(parsedExtraCatalog) && parsedExtraCatalog.length > 0) {
    const existingKeys = new Set(
      uiConfig.catalog.map(
        (m) => `${normalizeComparableText(m.pattern)}::${m.matchType}`,
      ),
    );
    for (const item of parsedExtraCatalog) {
      const key = `${normalizeComparableText(item?.pattern)}::${item?.matchType === "exact" ? "exact" : "contains"}`;
      if (item?.pattern && !existingKeys.has(key)) {
        uiConfig.catalog.push({
          id: `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          label: String(item.label || item.pattern).trim(),
          pattern: String(item.pattern).trim(),
          matchType: item.matchType === "exact" ? "exact" : "contains",
        });
        existingKeys.add(key);
      }
    }
  }

  if (params.ruleId === "new") {
    uiConfig.rules.push(normalizedRule);
  } else {
    const idx = uiConfig.rules.findIndex((r) => r.id === params.ruleId);
    if (idx === -1) {
      return {
        ok: false,
        error: "La regla que intentas editar ya no existe.",
      };
    }
    normalizedRule.id = params.ruleId;
    uiConfig.rules[idx] = normalizedRule;
  }

  const saveRes = await saveUiConfig(admin, uiConfig);
  if (!saveRes.ok) {
    return {
      ok: false,
      error: saveRes.error,
    };
  }

  return redirect("/app");
};

const getEventValue = (event) =>
  event.currentTarget?.value ?? event.target?.value ?? "";

const getEventChecked = (event) =>
  Boolean(event.currentTarget?.checked ?? event.target?.checked);

export default function RuleEditorPage() {
  const {
    isNew,
    notFound,
    initialRule,
    uiConfig,
    storeCatalog,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const navigate = useNavigate();
  const shopify = useAppBridge();

  const [rule, setRule] = useState(() =>
    initialRule ? structuredClone(initialRule) : createEmptyRule(),
  );
  const [clientErrors, setClientErrors] = useState(null);
  const [customPattern, setCustomPattern] = useState("");
  const [customMatchType, setCustomMatchType] = useState("contains");
  const [saveCustomToCatalog, setSaveCustomToCatalog] = useState(true);
  const [extraCatalog, setExtraCatalog] = useState([]);
  const [inlineMethodError, setInlineMethodError] = useState(null);

  const isSaving = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  const collectionsById = useMemo(() => {
    const map = {};
    for (const col of storeCatalog?.collections || []) {
      map[col.id] = col.title;
    }
    return map;
  }, [storeCatalog?.collections]);

  const metafieldDefinitions = useMemo(
    () => storeCatalog?.metafieldDefinitions || [],
    [storeCatalog?.metafieldDefinitions],
  );

  const combinedCatalog = useMemo(() => {
    const merged = [...(uiConfig?.catalog || []), ...extraCatalog];
    const seen = new Set();
    return merged.filter((m) => {
      const k = `${normalizeComparableText(m.pattern)}::${m.matchType}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [uiConfig?.catalog, extraCatalog]);

  const otherActiveMetafieldKeys = useMemo(() => {
    const set = new Set();
    for (const other of uiConfig?.rules || []) {
      if (!other.enabled || other.id === rule.id) continue;
      for (const c of other.conditions || []) {
        if (c.field === "metafield" && c.metafieldNamespace && c.metafieldKey) {
          set.add(`${c.metafieldNamespace}.${c.metafieldKey}`);
        }
      }
    }
    if (rule.enabled) {
      for (const c of rule.conditions || []) {
        if (c.field === "metafield" && c.metafieldNamespace && c.metafieldKey) {
          set.add(`${c.metafieldNamespace}.${c.metafieldKey}`);
        }
      }
    }
    return set;
  }, [uiConfig?.rules, rule]);

  if (notFound) {
    return (
      <s-page heading="Regla no encontrada" inlineSize="base">
        <s-button slot="primary-action" onClick={() => navigate("/app")}>
          Volver al inicio
        </s-button>
        <s-banner heading="Regla no encontrada" tone="critical">
          No se encontró ninguna regla con ese identificador.
        </s-banner>
      </s-page>
    );
  }

  const effectiveErrors = clientErrors || actionData?.fieldErrors || null;

  const updateCondition = (index, updater) => {
    setRule((prev) => {
      const nextConditions = prev.conditions.map((c, idx) =>
        idx === index ? updater(c) : c,
      );
      return { ...prev, conditions: nextConditions };
    });
  };

  const handleFieldChange = (index, nextField) => {
    const allowedOps = OPERATORS_BY_FIELD[nextField] || OPERATORS_BY_FIELD.tag;
    updateCondition(index, (prev) => ({
      ...prev,
      field: nextField,
      operator: allowedOps[0],
      value: "",
      metafieldNamespace:
        nextField === "metafield"
          ? metafieldDefinitions[0]?.namespace || "custom"
          : "",
      metafieldKey:
        nextField === "metafield" ? metafieldDefinitions[0]?.key || "" : "",
    }));
  };

  const handleAddCondition = () => {
    setRule((prev) => ({
      ...prev,
      conditions: [...prev.conditions, createEmptyCondition("tag")],
    }));
  };

  const handleRemoveCondition = (index) => {
    setRule((prev) => {
      if (prev.conditions.length <= 1) return prev;
      return {
        ...prev,
        conditions: prev.conditions.filter((_, idx) => idx !== index),
      };
    });
  };

  const isCatalogMethodSelected = (method) =>
    rule.targets.some(
      (t) =>
        normalizeComparableText(t.pattern) ===
          normalizeComparableText(method.pattern) &&
        t.matchType === method.matchType,
    );

  const handleToggleCatalogMethod = (method) => {
    setRule((prev) => {
      const methodKey = normalizeComparableText(method.pattern);
      const exists = prev.targets.some(
        (t) =>
          normalizeComparableText(t.pattern) === methodKey &&
          t.matchType === method.matchType,
      );
      if (exists) {
        return {
          ...prev,
          targets: prev.targets.filter(
            (t) =>
              !(
                normalizeComparableText(t.pattern) === methodKey &&
                t.matchType === method.matchType
              ),
          ),
        };
      }
      return {
        ...prev,
        targets: [
          ...prev.targets,
          {
            pattern: method.pattern,
            matchType: method.matchType,
            label: method.label,
          },
        ],
      };
    });
  };

  const handleAddCustomTarget = () => {
    const check = validateCatalogMethod({
      label: customPattern,
      pattern: customPattern,
    });
    if (!check.valid) {
      setInlineMethodError(check.errors.pattern);
      return;
    }
    setInlineMethodError(null);

    const trimmed = customPattern.trim();
    const newMethod = {
      id: `pm-inline-${Date.now().toString(36)}`,
      label: trimmed,
      pattern: trimmed,
      matchType: customMatchType,
    };

    if (saveCustomToCatalog) {
      setExtraCatalog((prev) => [...prev, newMethod]);
    }

    setRule((prev) => {
      const already = prev.targets.some(
        (t) =>
          t.pattern.trim().toLowerCase() === trimmed.toLowerCase() &&
          t.matchType === customMatchType,
      );
      if (already) return prev;
      return {
        ...prev,
        targets: [
          ...prev.targets,
          {
            pattern: trimmed,
            matchType: customMatchType,
            label: trimmed,
          },
        ],
      };
    });

    setCustomPattern("");
  };

  const handleRemoveTarget = (idx) => {
    setRule((prev) => ({
      ...prev,
      targets: prev.targets.filter((_, i) => i !== idx),
    }));
  };

  const handleSave = () => {
    const validation = validateRule(rule);
    if (!validation.valid) {
      setClientErrors(validation.errors);
      shopify.toast.show("Completa los campos marcados antes de guardar.", {
        isError: true,
      });
      return;
    }
    setClientErrors(null);
    const formData = new FormData();
    formData.set("rulePayload", JSON.stringify(rule));
    formData.set("extraCatalogPayload", JSON.stringify(extraCatalog));
    submit(formData, { method: "POST" });
  };

  return (
    <s-page
      heading={isNew ? "Nueva regla de pago" : `Editar: ${rule.name || "Regla"}`}
      inlineSize="base"
    >
      <s-button
        slot="primary-action"
        variant="primary"
        loading={isSaving || undefined}
        onClick={handleSave}
      >
        Guardar regla
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => navigate("/app")}
        disabled={isSaving || undefined}
      >
        Cancelar
      </s-button>

      {actionData?.error && (
        <s-banner heading="Error al guardar" tone="critical">
          {actionData.error}
        </s-banner>
      )}

      <s-section heading="Configuración general">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Nombre de la regla"
            name="ruleName"
            placeholder="Ej: Solo transferencia para productos reacondicionados"
            value={rule.name}
            required
            error={effectiveErrors?.name || undefined}
            onInput={(e) => {
              const name = getEventValue(e);
              setRule((prev) => ({ ...prev, name }));
            }}
          />

          <s-switch
            label="Regla activa"
            details="Solo las reglas activas se evalúan durante el checkout."
            checked={rule.enabled || undefined}
            onInput={(e) => {
              const enabled = getEventChecked(e);
              setRule((prev) => ({ ...prev, enabled }));
            }}
          />

          <s-select
            label="Alcance en el carrito"
            name="cartMatch"
            value={rule.cartMatch}
            details="Define si basta con un producto que cumpla la regla o deben cumplirla todos."
            onInput={(e) => {
              const cartMatch = getEventValue(e) === "all" ? "all" : "any";
              setRule((prev) => ({ ...prev, cartMatch }));
            }}
          >
            <s-option value="any">
              Si al menos UN producto del carrito cumple
            </s-option>
            <s-option value="all">
              Si TODOS los productos del carrito cumplen
            </s-option>
          </s-select>
        </s-stack>
      </s-section>

      <s-section heading="Condiciones de producto">
        <s-stack direction="block" gap="base">
          <s-select
            label="Combinación de condiciones por producto"
            name="conditionLogic"
            value={rule.conditionLogic}
            onInput={(e) => {
              const conditionLogic = getEventValue(e) === "any" ? "any" : "all";
              setRule((prev) => ({ ...prev, conditionLogic }));
            }}
          >
            <s-option value="all">
              Debe cumplir TODAS las condiciones (Y)
            </s-option>
            <s-option value="any">
              Debe cumplir AL MENOS UNA condición (O)
            </s-option>
          </s-select>

          {rule.conditions.map((cond, idx) => {
            const condErr = effectiveErrors?.conditions?.[idx] || {};
            const allowedOps =
              OPERATORS_BY_FIELD[cond.field] || OPERATORS_BY_FIELD.tag;
            const hideValueInput = VALUELESS_OPERATORS.has(cond.operator);

            const selectedDefId = metafieldDefinitions.find(
              (d) =>
                d.namespace === cond.metafieldNamespace &&
                d.key === cond.metafieldKey,
            )?.id;

            const metafieldSelectValue = selectedDefId || "__custom__";

            return (
              <s-box
                key={cond.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="base">
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-text type="strong">Condición {idx + 1}</s-text>
                    {rule.conditions.length > 1 && (
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => handleRemoveCondition(idx)}
                      >
                        Quitar
                      </s-button>
                    )}
                  </s-stack>

                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-select
                      label="Campo del producto"
                      value={cond.field}
                      onInput={(e) =>
                        handleFieldChange(idx, getEventValue(e))
                      }
                    >
                      {CONDITION_FIELDS.map((f) => (
                        <s-option key={f.value} value={f.value}>
                          {f.label}
                        </s-option>
                      ))}
                    </s-select>

                    <s-select
                      label="Operador"
                      value={cond.operator}
                      error={condErr.operator || undefined}
                      onInput={(e) => {
                        const operator = getEventValue(e);
                        updateCondition(idx, (prev) => ({
                          ...prev,
                          operator,
                        }));
                      }}
                    >
                      {allowedOps.map((op) => (
                        <s-option key={op} value={op}>
                          {OPERATOR_LABELS[op] || op}
                        </s-option>
                      ))}
                    </s-select>
                  </s-grid>

                  {cond.field === "metafield" && (
                    <s-stack direction="block" gap="small">
                      <s-select
                        label="Definición de metacampo en la tienda"
                        value={metafieldSelectValue}
                        details={`Metacampos distintos en uso en reglas activas: ${otherActiveMetafieldKeys.size} / ${MAX_METAFIELD_SLOTS}`}
                        onInput={(e) => {
                          const picked = getEventValue(e);
                          if (picked === "__custom__") {
                            updateCondition(idx, (prev) => ({
                              ...prev,
                              metafieldNamespace:
                                prev.metafieldNamespace || "custom",
                              metafieldKey: prev.metafieldKey || "",
                            }));
                            return;
                          }
                          const def = metafieldDefinitions.find(
                            (d) => d.id === picked,
                          );
                          if (def) {
                            updateCondition(idx, (prev) => ({
                              ...prev,
                              metafieldNamespace: def.namespace,
                              metafieldKey: def.key,
                            }));
                          }
                        }}
                      >
                        {metafieldDefinitions.map((def) => (
                          <s-option key={def.id} value={def.id}>
                            {def.name} ({def.namespace}.{def.key})
                          </s-option>
                        ))}
                        <s-option value="__custom__">
                          Otro metacampo (ingresar namespace y key)
                        </s-option>
                      </s-select>

                      {metafieldSelectValue === "__custom__" && (
                        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                          <s-text-field
                            label="Namespace"
                            placeholder="custom"
                            value={cond.metafieldNamespace}
                            error={condErr.metafieldNamespace || undefined}
                            onInput={(e) => {
                              const metafieldNamespace = getEventValue(e);
                              updateCondition(idx, (prev) => ({
                                ...prev,
                                metafieldNamespace,
                              }));
                            }}
                          />
                          <s-text-field
                            label="Clave (key)"
                            placeholder="condicion_equipo"
                            value={cond.metafieldKey}
                            error={condErr.metafieldKey || undefined}
                            onInput={(e) => {
                              const metafieldKey = getEventValue(e);
                              updateCondition(idx, (prev) => ({
                                ...prev,
                                metafieldKey,
                              }));
                            }}
                          />
                        </s-grid>
                      )}
                    </s-stack>
                  )}

                  {!hideValueInput && cond.field === "collection" && (
                    <s-stack direction="block" gap="small">
                      {(storeCatalog?.collections || []).length > 0 && (
                        <s-select
                          label="Colección de la tienda"
                          value={
                            (storeCatalog?.collections || []).some(
                              (c) => c.id === cond.value,
                            )
                              ? cond.value
                              : ""
                          }
                          onInput={(e) => {
                            const value = getEventValue(e);
                            if (value) {
                              updateCondition(idx, (prev) => ({
                                ...prev,
                                value,
                              }));
                            }
                          }}
                        >
                          <s-option value="">Selecciona una colección...</s-option>
                          {(storeCatalog?.collections || []).map((col) => (
                            <s-option key={col.id} value={col.id}>
                              {col.title}
                            </s-option>
                          ))}
                        </s-select>
                      )}
                      <s-text-field
                        label="ID de colección (GID de Shopify)"
                        placeholder="gid://shopify/Collection/123456789"
                        value={cond.value}
                        error={condErr.value || undefined}
                        onInput={(e) => {
                          const value = getEventValue(e);
                          updateCondition(idx, (prev) => ({
                            ...prev,
                            value,
                          }));
                        }}
                      />
                    </s-stack>
                  )}

                  {!hideValueInput && cond.field !== "collection" && (
                    <s-stack direction="block" gap="small">
                      {cond.field === "tag" &&
                        (storeCatalog?.productTags || []).length > 0 && (
                          <s-select
                            label="Elegir etiqueta existente (opcional)"
                            value=""
                            onInput={(e) => {
                              const value = getEventValue(e);
                              if (value) {
                                updateCondition(idx, (prev) => ({
                                  ...prev,
                                  value,
                                }));
                              }
                            }}
                          >
                            <s-option value="">
                              Autocompletar desde la tienda...
                            </s-option>
                            {(storeCatalog?.productTags || []).map((tag) => (
                              <s-option key={tag} value={tag}>
                                {tag}
                              </s-option>
                            ))}
                          </s-select>
                        )}

                      {cond.field === "product_type" &&
                        (storeCatalog?.productTypes || []).length > 0 && (
                          <s-select
                            label="Elegir tipo existente (opcional)"
                            value=""
                            onInput={(e) => {
                              const value = getEventValue(e);
                              if (value) {
                                updateCondition(idx, (prev) => ({
                                  ...prev,
                                  value,
                                }));
                              }
                            }}
                          >
                            <s-option value="">
                              Autocompletar desde la tienda...
                            </s-option>
                            {(storeCatalog?.productTypes || []).map((t) => (
                              <s-option key={t} value={t}>
                                {t}
                              </s-option>
                            ))}
                          </s-select>
                        )}

                      {cond.field === "vendor" &&
                        (storeCatalog?.productVendors || []).length > 0 && (
                          <s-select
                            label="Elegir proveedor existente (opcional)"
                            value=""
                            onInput={(e) => {
                              const value = getEventValue(e);
                              if (value) {
                                updateCondition(idx, (prev) => ({
                                  ...prev,
                                  value,
                                }));
                              }
                            }}
                          >
                            <s-option value="">
                              Autocompletar desde la tienda...
                            </s-option>
                            {(storeCatalog?.productVendors || []).map((v) => (
                              <s-option key={v} value={v}>
                                {v}
                              </s-option>
                            ))}
                          </s-select>
                        )}

                      <s-text-field
                        label={
                          cond.field === "price"
                            ? "Precio unitario a comparar"
                            : "Valor a comparar"
                        }
                        placeholder={
                          cond.field === "tag"
                            ? "reacondicionado"
                            : cond.field === "sku"
                              ? "SRV-001"
                              : cond.field === "price"
                                ? "Ej: 50000 o 19.99"
                                : "Valor esperado"
                        }
                        details={
                          cond.field === "price"
                            ? "Monto en la moneda del checkout, sin símbolo ni separador de miles."
                            : undefined
                        }
                        value={cond.value}
                        error={condErr.value || undefined}
                        onInput={(e) => {
                          const value = getEventValue(e);
                          updateCondition(idx, (prev) => ({
                            ...prev,
                            value,
                          }));
                        }}
                      />
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            );
          })}

          <s-button variant="secondary" onClick={handleAddCondition}>
            Agregar condición
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Acción sobre métodos de pago">
        <s-stack direction="block" gap="base">
          <s-select
            label="Acción a aplicar cuando se cumpla la regla"
            name="ruleAction"
            value={rule.action}
            onInput={(e) => {
              const action =
                getEventValue(e) === "allow_only_selected"
                  ? "allow_only_selected"
                  : "hide_selected";
              setRule((prev) => ({ ...prev, action }));
            }}
          >
            <s-option value="hide_selected">
              Ocultar los métodos seleccionados
            </s-option>
            <s-option value="allow_only_selected">
              Mostrar SOLO los métodos seleccionados (ocultar el resto)
            </s-option>
          </s-select>

          {effectiveErrors?.targets && (
            <s-banner tone="critical" heading="Selección requerida">
              {effectiveErrors.targets}
            </s-banner>
          )}

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-text type="strong">Métodos guardados en la app</s-text>
              {combinedCatalog.length === 0 ? (
                <s-paragraph color="subdued">
                  No hay métodos guardados todavía. Agrega uno abajo o desde la
                  pestaña Métodos de pago.
                </s-paragraph>
              ) : (
                combinedCatalog.map((method) => (
                  <s-checkbox
                    key={`${method.id}-${method.pattern}-${method.matchType}`}
                    label={`${method.label} (${method.matchType === "exact" ? "Exacto" : "Contiene"}: "${method.pattern}")`}
                    checked={isCatalogMethodSelected(method) || undefined}
                    onInput={() => handleToggleCatalogMethod(method)}
                  />
                ))
              )}
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text type="strong">Agregar otro método a esta regla</s-text>
              <s-grid
                gridTemplateColumns="1fr 180px auto"
                gap="base"
                alignItems="end"
              >
                <s-text-field
                  label="Nombre o palabra clave en checkout"
                  placeholder="Ej: Transferencia directa"
                  value={customPattern}
                  error={inlineMethodError || undefined}
                  onInput={(e) => setCustomPattern(getEventValue(e))}
                />
                <s-select
                  label="Coincidencia"
                  value={customMatchType}
                  onInput={(e) =>
                    setCustomMatchType(
                      getEventValue(e) === "exact" ? "exact" : "contains",
                    )
                  }
                >
                  <s-option value="contains">Contiene texto</s-option>
                  <s-option value="exact">Nombre exacto</s-option>
                </s-select>
                <s-button variant="secondary" onClick={handleAddCustomTarget}>
                  Agregar
                </s-button>
              </s-grid>

              <s-checkbox
                label="Guardar también en mi lista reutilizable de Métodos de pago"
                checked={saveCustomToCatalog || undefined}
                onInput={(e) => setSaveCustomToCatalog(getEventChecked(e))}
              />
            </s-stack>
          </s-box>

          {rule.targets.length > 0 && (
            <s-stack direction="block" gap="small">
              <s-text type="strong">
                Métodos seleccionados ({rule.targets.length})
              </s-text>
              <s-stack direction="inline" gap="small">
                {rule.targets.map((target, idx) => (
                  <s-box
                    key={`${target.pattern}-${target.matchType}-${idx}`}
                    padding="small"
                    borderWidth="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-text>
                        {target.label || target.pattern} (
                        {target.matchType === "exact" ? "Exacto" : "Contiene"})
                      </s-text>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        accessibilityLabel={`Quitar ${target.pattern}`}
                        onClick={() => handleRemoveTarget(idx)}
                      >
                        Quitar
                      </s-button>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Resumen de la regla">
        <s-box
          padding="base"
          background="subdued"
          borderWidth="base"
          borderRadius="base"
        >
          <s-paragraph>{formatRuleSummary(rule, collectionsById)}</s-paragraph>
        </s-box>
        <s-paragraph color="subdued">
          La comparación de texto, etiquetas y métodos de pago ignora
          automáticamente mayúsculas, minúsculas, tildes y espacios al inicio o
          al final.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
