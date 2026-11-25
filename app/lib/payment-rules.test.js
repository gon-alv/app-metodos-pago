import test from "node:test";
import assert from "node:assert/strict";
import {
  compileFunctionPayloads,
  createDefaultUiConfig,
  formatRuleSummary,
  MAX_METAFIELD_SLOTS,
  MAX_RULES_CONFIG_BYTES,
  normalizeComparableText,
  SAMPLE_RULE_TEMPLATES,
  UNUSED_METAFIELD_SENTINEL,
  validateCatalogMethod,
  validateRule,
} from "./payment-rules.js";

test("compileFunctionPayloads includes all 10 inputVars keys when empty", () => {
  const config = createDefaultUiConfig();
  const compiled = compileFunctionPayloads(config);

  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.rulesConfig, { failSafe: true, rules: [] });
  assert.deepEqual(compiled.inputVars, {
    watchedTags: [],
    watchedCollections: [],
    mf0Ns: UNUSED_METAFIELD_SENTINEL,
    mf0Key: UNUSED_METAFIELD_SENTINEL,
    mf1Ns: UNUSED_METAFIELD_SENTINEL,
    mf1Key: UNUSED_METAFIELD_SENTINEL,
    mf2Ns: UNUSED_METAFIELD_SENTINEL,
    mf2Key: UNUSED_METAFIELD_SENTINEL,
    mf3Ns: UNUSED_METAFIELD_SENTINEL,
    mf3Key: UNUSED_METAFIELD_SENTINEL,
  });
});

test("compileFunctionPayloads compiles sample templates and deduplicates tags/metafields", () => {
  const config = createDefaultUiConfig();
  config.rules = [
    ...SAMPLE_RULE_TEMPLATES,
    {
      id: "r-mf",
      name: "Metacampo repetido",
      enabled: true,
      cartMatch: "all",
      conditionLogic: "any",
      conditions: [
        {
          id: "c1",
          field: "metafield",
          operator: "equals",
          value: "usado",
          metafieldNamespace: "custom",
          metafieldKey: "estado",
        },
        {
          id: "c2",
          field: "metafield",
          operator: "not_equals",
          value: "nuevo",
          metafieldNamespace: "custom",
          metafieldKey: "estado",
        },
        {
          id: "c3",
          field: "collection",
          operator: "in",
          value: "gid://shopify/Collection/77",
        },
      ],
      action: "hide_selected",
      targets: [{ pattern: "PayPal", matchType: "exact" }],
    },
  ];

  const compiled = compileFunctionPayloads(config);
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.inputVars.watchedTags, [
    "reacondicionado",
    "servicio-tecnico",
  ]);
  assert.deepEqual(compiled.inputVars.watchedCollections, [
    "gid://shopify/Collection/77",
  ]);
  assert.equal(compiled.inputVars.mf0Ns, "custom");
  assert.equal(compiled.inputVars.mf0Key, "estado");
  assert.equal(compiled.inputVars.mf1Ns, UNUSED_METAFIELD_SENTINEL);
  assert.equal(compiled.rulesConfig.rules.length, 3);
  assert.equal(compiled.rulesConfig.rules[2].conditions[0].metafieldSlot, 0);
  assert.equal(compiled.rulesConfig.rules[2].conditions[1].metafieldSlot, 0);
  assert.equal(compiled.rulesConfig.rules[2].conditions[2].metafieldSlot, -1);
});

test("disabled rules do not consume metafield slots", () => {
  const config = createDefaultUiConfig();
  for (let i = 0; i < 4; i++) {
    config.rules.push({
      id: `active-${i}`,
      name: `Activa ${i}`,
      enabled: true,
      cartMatch: "any",
      conditionLogic: "all",
      conditions: [
        {
          id: `c-${i}`,
          field: "metafield",
          operator: "equals",
          value: "1",
          metafieldNamespace: "custom",
          metafieldKey: `k_${i}`,
        },
      ],
      action: "hide_selected",
      targets: [{ pattern: "paypal", matchType: "contains" }],
    });
  }
  config.rules.push({
    id: "paused-5",
    name: "Pausada 5",
    enabled: false,
    cartMatch: "any",
    conditionLogic: "all",
    conditions: [
      {
        id: "c-5",
        field: "metafield",
        operator: "equals",
        value: "1",
        metafieldNamespace: "custom",
        metafieldKey: "k_5",
      },
    ],
    action: "hide_selected",
    targets: [{ pattern: "paypal", matchType: "contains" }],
  });

  const okCompiled = compileFunctionPayloads(config);
  assert.equal(okCompiled.ok, true);
  assert.equal(okCompiled.activeMetafields.length, MAX_METAFIELD_SLOTS);

  config.rules[4].enabled = true;
  const overLimit = compileFunctionPayloads(config);
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.error, /máximo de 4 metacampos/);
});

test("compileFunctionPayloads rejects oversized rules-config", () => {
  const config = createDefaultUiConfig();
  const bigTargets = Array.from({ length: 220 }, (_, idx) => ({
    pattern: `metodo-de-pago-muy-largo-${idx}-${"x".repeat(25)}`,
    matchType: "contains",
  }));

  config.rules.push({
    id: "big",
    name: "Regla enorme",
    enabled: true,
    cartMatch: "any",
    conditionLogic: "all",
    conditions: [{ id: "c", field: "tag", operator: "equals", value: "vip" }],
    action: "hide_selected",
    targets: bigTargets,
  });

  const res = compileFunctionPayloads(config);
  assert.equal(res.ok, false);
  assert.match(
    res.error,
    new RegExp(String(MAX_RULES_CONFIG_BYTES)),
  );
});

test("validateRule and validateCatalogMethod enforce Spanish validation messages", () => {
  const badRule = validateRule({
    name: "",
    conditions: [
      {
        field: "metafield",
        operator: "gt",
        value: "no-num",
        metafieldNamespace: "",
        metafieldKey: "",
      },
    ],
    targets: [],
  });
  assert.equal(badRule.valid, false);
  assert.ok(badRule.errors.name);
  assert.ok(badRule.errors.targets);
  assert.ok(badRule.errors.conditions[0].metafieldNamespace);
  assert.ok(badRule.errors.conditions[0].metafieldKey);
  assert.ok(badRule.errors.conditions[0].value);

  const emptyAllowed = validateRule({
    name: "Sin tipo",
    conditions: [
      {
        field: "product_type",
        operator: "is_empty",
        value: "",
      },
    ],
    targets: [{ pattern: "pago en tienda", matchType: "contains" }],
  });
  assert.equal(emptyAllowed.valid, true);

  const badMethod = validateCatalogMethod({ label: "", pattern: "" });
  assert.equal(badMethod.valid, false);
  assert.ok(badMethod.errors.label);
  assert.ok(badMethod.errors.pattern);
});

test("formatRuleSummary resolves collection title and Spanish summary", () => {
  const summary = formatRuleSummary(
    {
      cartMatch: "any",
      conditionLogic: "all",
      conditions: [
        {
          field: "collection",
          operator: "in",
          value: "gid://shopify/Collection/1",
        },
      ],
      action: "allow_only_selected",
      targets: [{ label: "Transferencia directa", pattern: "transferencia" }],
    },
    { "gid://shopify/Collection/1": "Outlet Reacondicionados" },
  );

  assert.match(summary, /Outlet Reacondicionados/);
  assert.match(summary, /mostrar SOLO/);
  assert.match(summary, /Transferencia directa/);
});

test("validateRule and compileFunctionPayloads support price conditions", () => {
  const invalidNonNumeric = validateRule({
    name: "Precio inválido",
    conditions: [{ field: "price", operator: "gt", value: "50.000,00" }],
    targets: [{ pattern: "pago en tienda", matchType: "contains" }],
  });
  assert.equal(invalidNonNumeric.valid, false);
  assert.match(
    invalidNonNumeric.errors.conditions[0].value,
    /número válido/,
  );

  const invalidNegative = validateRule({
    name: "Precio negativo",
    conditions: [{ field: "price", operator: "equals", value: "-10" }],
    targets: [{ pattern: "pago en tienda", matchType: "contains" }],
  });
  assert.equal(invalidNegative.valid, false);
  assert.match(
    invalidNegative.errors.conditions[0].value,
    /negativo/,
  );

  const validConfig = createDefaultUiConfig();
  validConfig.rules.push({
    id: "r-price",
    name: "Precio mayor a 50000",
    enabled: true,
    cartMatch: "any",
    conditionLogic: "all",
    conditions: [
      { id: "c-p1", field: "price", operator: "gt", value: "50000" },
      { id: "c-p2", field: "price", operator: "lte", value: "99999.99" },
    ],
    action: "hide_selected",
    targets: [{ pattern: "pago en tienda", matchType: "contains" }],
  });

  const compiled = compileFunctionPayloads(validConfig);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.rulesConfig.rules[0].conditions[0].field, "price");
  assert.equal(compiled.rulesConfig.rules[0].conditions[0].operator, "gt");
  assert.equal(compiled.rulesConfig.rules[0].conditions[0].value, "50000");
  assert.equal(compiled.rulesConfig.rules[0].conditions[0].metafieldSlot, -1);
});

test("normalizeComparableText strips vocalic tildes while preserving ñ", () => {
  assert.equal(
    normalizeComparableText("  Depósito Débito Ñandú  "),
    "deposito debito ñandu",
  );
  assert.equal(normalizeComparableText("VIDEÓGRAFO"), "videografo");
});
