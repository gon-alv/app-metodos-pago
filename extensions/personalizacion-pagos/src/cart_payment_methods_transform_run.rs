use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::HashSet;

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Configuration {
    pub fail_safe: bool,
    pub rules: Vec<Rule>,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Rule {
    pub cart_match: String,
    pub condition_logic: String,
    pub conditions: Vec<Condition>,
    pub action: String,
    pub targets: Vec<PaymentTarget>,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Condition {
    pub field: String,
    pub operator: String,
    pub value: String,
    pub metafield_slot: i32,
}

#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct PaymentTarget {
    pub pattern: String,
    pub match_type: String,
}

struct CartItem<'a> {
    variant: &'a schema::cart_payment_methods_transform_run::input::cart::lines::merchandise::ProductVariant,
    unit_price: f64,
}

fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.trim().to_lowercase().chars() {
        match ch {
            '\u{0300}' | '\u{0301}' | '\u{0302}' | '\u{0308}' => continue,
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => out.push('a'),
            'é' | 'è' | 'ë' | 'ê' => out.push('e'),
            'í' | 'ì' | 'ï' | 'î' => out.push('i'),
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => out.push('o'),
            'ú' | 'ù' | 'ü' | 'û' => out.push('u'),
            'ý' | 'ÿ' => out.push('y'),
            _ => out.push(ch),
        }
    }
    out
}

fn eval_price(unit_price: f64, operator: &str, expected: &str) -> bool {
    let expected_num = match expected.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => n,
        _ => return false,
    };

    const EPS: f64 = 1e-6;
    match operator {
        "equals" => (unit_price - expected_num).abs() < EPS,
        "not_equals" => (unit_price - expected_num).abs() >= EPS,
        "gt" => unit_price > expected_num + EPS,
        "gte" => unit_price >= expected_num - EPS,
        "lt" => unit_price < expected_num - EPS,
        "lte" => unit_price <= expected_num + EPS,
        _ => false,
    }
}

fn eval_scalar(actual: Option<&str>, operator: &str, expected: &str) -> bool {
    let trimmed_actual = actual.map(str::trim).unwrap_or("");
    let actual_norm = normalize(trimmed_actual);
    let expected_norm = normalize(expected);

    match operator {
        "is_empty" => trimmed_actual.is_empty(),
        "is_not_empty" => !trimmed_actual.is_empty(),
        "equals" => !trimmed_actual.is_empty() && actual_norm == expected_norm,
        "not_equals" => actual_norm != expected_norm,
        "contains" => {
            !expected_norm.is_empty()
                && !trimmed_actual.is_empty()
                && actual_norm.contains(&expected_norm)
        }
        "not_contains" => expected_norm.is_empty() || !actual_norm.contains(&expected_norm),
        "starts_with" => {
            !expected_norm.is_empty()
                && !trimmed_actual.is_empty()
                && actual_norm.starts_with(&expected_norm)
        }
        "gt" | "gte" | "lt" | "lte" => {
            let actual_num = match trimmed_actual.parse::<f64>() {
                Ok(n) if n.is_finite() => n,
                _ => return false,
            };
            let expected_num = match expected.trim().parse::<f64>() {
                Ok(n) if n.is_finite() => n,
                _ => return false,
            };
            match operator {
                "gt" => actual_num > expected_num,
                "gte" => actual_num >= expected_num,
                "lt" => actual_num < expected_num,
                "lte" => actual_num <= expected_num,
                _ => false,
            }
        }
        _ => false,
    }
}

fn eval_condition(cond: &Condition, item: &CartItem<'_>) -> bool {
    let variant = item.variant;
    let product = variant.product();

    match cond.field.as_str() {
        "price" => eval_price(item.unit_price, &cond.operator, &cond.value),
        "tag" => {
            let expected = normalize(&cond.value);
            if expected.is_empty() {
                return false;
            }
            let has_tag = product
                .has_tags()
                .iter()
                .any(|entry| *entry.has_tag() && normalize(entry.tag()) == expected);

            match cond.operator.as_str() {
                "equals" | "in" => has_tag,
                "not_equals" | "not_in" => !has_tag,
                _ => false,
            }
        }
        "collection" => {
            let expected = cond.value.trim();
            if expected.is_empty() {
                return false;
            }
            let is_member = product
                .in_collections()
                .iter()
                .any(|entry| *entry.is_member() && entry.collection_id().trim() == expected);

            match cond.operator.as_str() {
                "in" | "equals" => is_member,
                "not_in" | "not_equals" => !is_member,
                _ => false,
            }
        }
        "product_type" => eval_scalar(
            product.product_type().map(|s| s.as_str()),
            &cond.operator,
            &cond.value,
        ),
        "vendor" => eval_scalar(
            product.vendor().map(|s| s.as_str()),
            &cond.operator,
            &cond.value,
        ),
        "sku" => eval_scalar(
            variant.sku().map(|s| s.as_str()),
            &cond.operator,
            &cond.value,
        ),
        "title" => eval_scalar(Some(product.title().as_str()), &cond.operator, &cond.value),
        "metafield" => {
            let metafield_value = match cond.metafield_slot {
                0 => product.mf_0().map(|m| m.value().as_str()),
                1 => product.mf_1().map(|m| m.value().as_str()),
                2 => product.mf_2().map(|m| m.value().as_str()),
                3 => product.mf_3().map(|m| m.value().as_str()),
                _ => None,
            };
            eval_scalar(metafield_value, &cond.operator, &cond.value)
        }
        _ => false,
    }
}

fn eval_rule_on_item(rule: &Rule, item: &CartItem<'_>) -> bool {
    if rule.conditions.is_empty() {
        return false;
    }

    match rule.condition_logic.as_str() {
        "any" => rule
            .conditions
            .iter()
            .any(|cond| eval_condition(cond, item)),
        _ => rule
            .conditions
            .iter()
            .all(|cond| eval_condition(cond, item)),
    }
}

fn rule_matches_cart(rule: &Rule, items: &[CartItem<'_>]) -> bool {
    if items.is_empty() {
        return false;
    }

    match rule.cart_match.as_str() {
        "all" => items.iter().all(|item| eval_rule_on_item(rule, item)),
        _ => items.iter().any(|item| eval_rule_on_item(rule, item)),
    }
}

fn native_spanish_aliases(normalized_method_name: &str) -> &'static [&'static str] {
    match normalized_method_name {
        "bank deposit" => &["deposito bancario"],
        "money order" => &["giro postal"],
        "cash on delivery (cod)" => &["pago contra entrega (cod)", "pago contra entrega"],
        "cash on delivery" => &["pago contra entrega"],
        "gift card" => &["tarjeta de regalo"],
        "deferred" => &["pago diferido"],
        "(for testing) bogus gateway" => &["(para pruebas) pasarela simulada", "pasarela simulada"],
        _ => &[],
    }
}

fn matches_payment_method(target: &PaymentTarget, method_name: &str) -> bool {
    let pattern_norm = normalize(&target.pattern);
    if pattern_norm.is_empty() {
        return false;
    }
    let name_norm = normalize(method_name);
    let aliases = native_spanish_aliases(&name_norm);

    match target.match_type.as_str() {
        "exact" => name_norm == pattern_norm || aliases.iter().any(|alias| *alias == pattern_norm),
        _ => {
            name_norm.contains(&pattern_norm)
                || aliases.iter().any(|alias| alias.contains(&pattern_norm))
        }
    }
}

#[shopify_function]
fn cart_payment_methods_transform_run(
    input: schema::cart_payment_methods_transform_run::Input,
) -> Result<schema::CartPaymentMethodsTransformRunResult> {
    let no_changes = schema::CartPaymentMethodsTransformRunResult { operations: vec![] };

    let config = match input.payment_customization().metafield() {
        Some(metafield) => metafield.json_value(),
        None => return Ok(no_changes),
    };

    if config.rules.is_empty() || input.payment_methods().is_empty() {
        return Ok(no_changes);
    }

    let mut items = Vec::new();
    for line in input.cart().lines().iter() {
        match line.merchandise() {
            schema::cart_payment_methods_transform_run::input::cart::lines::Merchandise::ProductVariant(variant) => {
                items.push(CartItem {
                    variant,
                    unit_price: line.cost().amount_per_quantity().amount().as_f64(),
                });
            }
            _ => continue,
        }
    }

    if items.is_empty() {
        return Ok(no_changes);
    }

    let mut hidden_ids: HashSet<String> = HashSet::new();

    for rule in config.rules.iter() {
        if rule.targets.is_empty() || !rule_matches_cart(rule, &items) {
            continue;
        }

        match rule.action.as_str() {
            "hide_selected" => {
                for pm in input.payment_methods().iter() {
                    if rule
                        .targets
                        .iter()
                        .any(|target| matches_payment_method(target, pm.name()))
                    {
                        hidden_ids.insert(pm.id().clone());
                    }
                }
            }
            "allow_only_selected" => {
                for pm in input.payment_methods().iter() {
                    let is_allowed = rule
                        .targets
                        .iter()
                        .any(|target| matches_payment_method(target, pm.name()));
                    if !is_allowed {
                        hidden_ids.insert(pm.id().clone());
                    }
                }
            }
            _ => continue,
        }
    }

    if hidden_ids.is_empty() {
        return Ok(no_changes);
    }

    if config.fail_safe && hidden_ids.len() >= input.payment_methods().len() {
        return Ok(no_changes);
    }

    let operations = input
        .payment_methods()
        .iter()
        .filter(|pm| hidden_ids.contains(pm.id()))
        .map(|pm| {
            schema::Operation::PaymentMethodHide(schema::PaymentMethodHideOperation {
                payment_method_id: pm.id().clone(),
                placements: None,
            })
        })
        .collect();

    Ok(schema::CartPaymentMethodsTransformRunResult { operations })
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    fn hide_op(id: &str) -> schema::Operation {
        schema::Operation::PaymentMethodHide(schema::PaymentMethodHideOperation {
            payment_method_id: id.to_string(),
            placements: None,
        })
    }

    fn default_payment_methods_json() -> &'static str {
        r#"[
            { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Transferencia directa" },
            { "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Pago en tienda" },
            { "id": "gid://shopify/PaymentCustomizationPaymentMethod/3", "name": "Tarjeta de crédito" }
        ]"#
    }

    #[test]
    fn test_missing_metafield_and_empty_rules() -> Result<()> {
        let result_null = run_function_with_input(
            cart_payment_methods_transform_run,
            r#"{
                "cart": { "lines": [] },
                "paymentMethods": [],
                "paymentCustomization": { "metafield": null }
            }"#,
        )?;
        assert_eq!(result_null.operations.len(), 0);

        let result_empty = run_function_with_input(
            cart_payment_methods_transform_run,
            format!(
                r#"{{
                    "cart": {{ "lines": [] }},
                    "paymentMethods": {},
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{ "failSafe": true, "rules": [] }}
                        }}
                    }}
                }}"#,
                default_payment_methods_json()
            )
            .as_str(),
        )?;
        assert_eq!(result_empty.operations.len(), 0);
        Ok(())
    }

    #[test]
    fn test_reacondicionado_allow_only_transferencia() -> Result<()> {
        let result = run_function_with_input(
            cart_payment_methods_transform_run,
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "SKU-1",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "iPhone Reacondicionado",
                                        "productType": "Smartphone",
                                        "vendor": "Apple",
                                        "hasTags": [
                                            {{ "tag": "reacondicionado", "hasTag": true }},
                                            {{ "tag": "servicio-tecnico", "hasTag": false }}
                                        ],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": {},
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": true,
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "reacondicionado", "metafieldSlot": -1 }}
                                        ],
                                        "action": "allow_only_selected",
                                        "targets": [
                                            {{ "pattern": "transferencia directa", "matchType": "contains" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                default_payment_methods_json()
            )
            .as_str(),
        )?;

        assert_eq!(
            result.operations,
            vec![
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2"),
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/3"),
            ]
        );
        Ok(())
    }

    #[test]
    fn test_servicio_tecnico_hides_pago_en_tienda() -> Result<()> {
        let result = run_function_with_input(
            cart_payment_methods_transform_run,
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "SRV-01",
                                    "product": {{
                                        "id": "gid://shopify/Product/2",
                                        "title": "Cambio de pantalla",
                                        "productType": "Servicio",
                                        "vendor": "Taller",
                                        "hasTags": [
                                            {{ "tag": "servicio-tecnico", "hasTag": true }}
                                        ],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": {},
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": true,
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "servicio-tecnico", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "pago en tienda", "matchType": "contains" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                default_payment_methods_json()
            )
            .as_str(),
        )?;

        assert_eq!(
            result.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );
        Ok(())
    }

    #[test]
    fn test_mixed_cart_cumulative_rules() -> Result<()> {
        let result = run_function_with_input(
            cart_payment_methods_transform_run,
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "R-1",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "Laptop Reacondicionada",
                                        "productType": "Laptop",
                                        "vendor": "Dell",
                                        "hasTags": [
                                            {{ "tag": "reacondicionado", "hasTag": true }},
                                            {{ "tag": "servicio-tecnico", "hasTag": false }}
                                        ],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }},
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "S-1",
                                    "product": {{
                                        "id": "gid://shopify/Product/2",
                                        "title": "Diagnóstico",
                                        "productType": "Servicio",
                                        "vendor": "Taller",
                                        "hasTags": [
                                            {{ "tag": "reacondicionado", "hasTag": false }},
                                            {{ "tag": "servicio-tecnico", "hasTag": true }}
                                        ],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": [
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Transferencia directa" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Pago en tienda" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/3", "name": "Tarjeta de crédito" }}
                    ],
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": true,
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "reacondicionado", "metafieldSlot": -1 }}
                                        ],
                                        "action": "allow_only_selected",
                                        "targets": [
                                            {{ "pattern": "transferencia directa", "matchType": "contains" }},
                                            {{ "pattern": "pago en tienda", "matchType": "contains" }}
                                        ]
                                    }},
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "servicio-tecnico", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "pago en tienda", "matchType": "contains" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#
            )
            .as_str(),
        )?;

        assert_eq!(
            result.operations,
            vec![
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2"),
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/3"),
            ]
        );
        Ok(())
    }

    #[test]
    fn test_failsafe_prevents_or_allows_hiding_all_methods() -> Result<()> {
        let make_input = |fail_safe: bool| {
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "X1",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "Item",
                                        "productType": "Equipo",
                                        "vendor": "Marca",
                                        "hasTags": [{{ "tag": "reacondicionado", "hasTag": true }}],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": [
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Transferencia directa" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Pago en tienda" }}
                    ],
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": {},
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "reacondicionado", "metafieldSlot": -1 }}
                                        ],
                                        "action": "allow_only_selected",
                                        "targets": [
                                            {{ "pattern": "transferencia directa", "matchType": "contains" }}
                                        ]
                                    }},
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "reacondicionado", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "transferencia directa", "matchType": "contains" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                fail_safe
            )
        };

        let guarded = run_function_with_input(cart_payment_methods_transform_run, &make_input(true))?;
        assert_eq!(guarded.operations.len(), 0);

        let unguarded = run_function_with_input(cart_payment_methods_transform_run, &make_input(false))?;
        assert_eq!(
            unguarded.operations,
            vec![
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/1"),
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2"),
            ]
        );
        Ok(())
    }

    #[test]
    fn test_multi_condition_and_or_standard_fields() -> Result<()> {
        let input = format!(
            r#"{{
                "cart": {{
                    "lines": [
                        {{
                            "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                            "merchandise": {{
                                "__typename": "ProductVariant",
                                "sku": "PRO-2026-CL",
                                "product": {{
                                    "id": "gid://shopify/Product/10",
                                    "title": "MacBook Pro Seminuevo",
                                    "productType": "Notebook",
                                    "vendor": "SmartMob",
                                    "hasTags": [{{ "tag": "b2b", "hasTag": true }}],
                                    "inCollections": [{{ "collectionId": "gid://shopify/Collection/50", "isMember": true }}],
                                    "mf0": null,
                                    "mf1": null,
                                    "mf2": null,
                                    "mf3": null
                                }}
                            }}
                        }}
                    ]
                }},
                "paymentMethods": {},
                "paymentCustomization": {{
                    "metafield": {{
                        "jsonValue": {{
                            "failSafe": true,
                            "rules": [
                                {{
                                    "cartMatch": "any",
                                    "conditionLogic": "all",
                                    "conditions": [
                                        {{ "field": "tag", "operator": "equals", "value": "B2B", "metafieldSlot": -1 }},
                                        {{ "field": "collection", "operator": "in", "value": "gid://shopify/Collection/50", "metafieldSlot": -1 }},
                                        {{ "field": "product_type", "operator": "equals", "value": "notebook", "metafieldSlot": -1 }},
                                        {{ "field": "vendor", "operator": "contains", "value": "smart", "metafieldSlot": -1 }},
                                        {{ "field": "sku", "operator": "starts_with", "value": "pro-", "metafieldSlot": -1 }},
                                        {{ "field": "title", "operator": "contains", "value": "seminuevo", "metafieldSlot": -1 }}
                                    ],
                                    "action": "hide_selected",
                                    "targets": [
                                        {{ "pattern": "tarjeta", "matchType": "contains" }}
                                    ]
                                }}
                            ]
                        }}
                    }}
                }}
            }}"#,
            default_payment_methods_json()
        );

        let result_and = run_function_with_input(cart_payment_methods_transform_run, &input)?;
        assert_eq!(
            result_and.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/3")]
        );

        let input_or = input
            .replace(r#""conditionLogic": "all""#, r#""conditionLogic": "any""#)
            .replace(r#""value": "notebook""#, r#""value": "tablet""#);
        let result_or = run_function_with_input(cart_payment_methods_transform_run, &input_or)?;
        assert_eq!(
            result_or.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/3")]
        );
        Ok(())
    }

    #[test]
    fn test_cart_match_all_vs_any() -> Result<()> {
        let make_cart_input = |cart_match: &str| {
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "A1",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "Prod A",
                                        "productType": "Digital",
                                        "vendor": "V1",
                                        "hasTags": [],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }},
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "B1",
                                    "product": {{
                                        "id": "gid://shopify/Product/2",
                                        "title": "Prod B",
                                        "productType": "Fisico",
                                        "vendor": "V1",
                                        "hasTags": [],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": {},
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": true,
                                "rules": [
                                    {{
                                        "cartMatch": "{}",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "product_type", "operator": "equals", "value": "Digital", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "pago en tienda", "matchType": "contains" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                default_payment_methods_json(),
                cart_match
            )
        };

        let res_all = run_function_with_input(cart_payment_methods_transform_run, &make_cart_input("all"))?;
        assert_eq!(res_all.operations.len(), 0);

        let res_any = run_function_with_input(cart_payment_methods_transform_run, &make_cart_input("any"))?;
        assert_eq!(
            res_any.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );
        Ok(())
    }

    #[test]
    fn test_metafield_slots_numeric_and_null() -> Result<()> {
        let input = format!(
            r#"{{
                "cart": {{
                    "lines": [
                        {{
                            "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                            "merchandise": {{
                                "__typename": "ProductVariant",
                                "sku": "M1",
                                "product": {{
                                    "id": "gid://shopify/Product/99",
                                    "title": "Producto con metacampos",
                                    "productType": "Hardware",
                                    "vendor": "Brand",
                                    "hasTags": [],
                                    "inCollections": [],
                                    "mf0": {{ "value": "reacondicionado" }},
                                    "mf1": {{ "value": "1500.5" }},
                                    "mf2": null,
                                    "mf3": {{ "value": "true" }}
                                }}
                            }}
                        }}
                    ]
                }},
                "paymentMethods": {},
                "paymentCustomization": {{
                    "metafield": {{
                        "jsonValue": {{
                            "failSafe": true,
                            "rules": [
                                {{
                                    "cartMatch": "any",
                                    "conditionLogic": "all",
                                    "conditions": [
                                        {{ "field": "metafield", "operator": "equals", "value": "REACONDICIONADO", "metafieldSlot": 0 }},
                                        {{ "field": "metafield", "operator": "gt", "value": "1000", "metafieldSlot": 1 }},
                                        {{ "field": "metafield", "operator": "is_empty", "value": "", "metafieldSlot": 2 }},
                                        {{ "field": "metafield", "operator": "equals", "value": "true", "metafieldSlot": 3 }}
                                    ],
                                    "action": "hide_selected",
                                    "targets": [
                                        {{ "pattern": "tarjeta", "matchType": "contains" }}
                                    ]
                                }}
                            ]
                        }}
                    }}
                }}
            }}"#,
            default_payment_methods_json()
        );

        let result = run_function_with_input(cart_payment_methods_transform_run, &input)?;
        assert_eq!(
            result.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/3")]
        );

        let input_null_gt = input.replace(r#""metafieldSlot": 1"#, r#""metafieldSlot": 2"#);
        let result_null = run_function_with_input(cart_payment_methods_transform_run, &input_null_gt)?;
        assert_eq!(result_null.operations.len(), 0);
        Ok(())
    }

    #[test]
    fn test_exact_vs_contains_matching() -> Result<()> {
        let make_target_input = |pattern: &str, match_type: &str| {
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "X",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "X",
                                        "productType": "SoloExacto",
                                        "vendor": "V",
                                        "hasTags": [],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": [
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Pago en tienda (Sucursal Centro)" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Transferencia directa" }}
                    ],
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": true,
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "product_type", "operator": "equals", "value": "soloexacto", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "{}", "matchType": "{}" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                pattern, match_type
            )
        };

        let exact_miss = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_target_input("Pago en tienda", "exact"),
        )?;
        assert_eq!(exact_miss.operations.len(), 0);

        let exact_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_target_input("  pago en tienda (sucursal centro)  ", "exact"),
        )?;
        assert_eq!(
            exact_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/1")]
        );

        let contains_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_target_input("PAGO EN TIENDA", "contains"),
        )?;
        assert_eq!(
            contains_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/1")]
        );
        Ok(())
    }

    #[test]
    fn test_price_equals_greater_and_less_conditions() -> Result<()> {
        let make_price_input = |unit_price: &str, operator: &str, expected: &str| {
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "{}" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "P-1",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "Producto",
                                        "productType": "Hardware",
                                        "vendor": "Marca",
                                        "hasTags": [],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": {},
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": true,
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "price", "operator": "{}", "value": "{}", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "pago en tienda", "matchType": "contains" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                unit_price,
                default_payment_methods_json(),
                operator,
                expected
            )
        };

        let eq_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("100.00", "equals", "100"),
        )?;
        assert_eq!(
            eq_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );

        let eq_miss = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("99.99", "equals", "100"),
        )?;
        assert_eq!(eq_miss.operations.len(), 0);

        let gt_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("50000.50", "gt", "50000"),
        )?;
        assert_eq!(
            gt_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );

        let gt_equal_miss = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("50000.00", "gt", "50000"),
        )?;
        assert_eq!(gt_equal_miss.operations.len(), 0);

        let lt_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("19.95", "lt", "20"),
        )?;
        assert_eq!(
            lt_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );

        let gte_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("250.00", "gte", "250"),
        )?;
        assert_eq!(
            gte_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );

        let lte_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("250.00", "lte", "250"),
        )?;
        assert_eq!(
            lte_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );

        let neq_hit = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_price_input("150.00", "not_equals", "100"),
        )?;
        assert_eq!(
            neq_hit.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
        );

        Ok(())
    }

    #[test]
    fn test_native_shopify_spanish_equivalences() -> Result<()> {
        let make_native_input = |pattern: &str, match_type: &str| {
            format!(
                r#"{{
                    "cart": {{
                        "lines": [
                            {{
                                "cost": {{ "amountPerQuantity": {{ "amount": "100.00" }} }},
                                "merchandise": {{
                                    "__typename": "ProductVariant",
                                    "sku": "NAT-1",
                                    "product": {{
                                        "id": "gid://shopify/Product/1",
                                        "title": "Test",
                                        "productType": "Test",
                                        "vendor": "Test",
                                        "hasTags": [{{ "tag": "test-es", "hasTag": true }}],
                                        "inCollections": [],
                                        "mf0": null,
                                        "mf1": null,
                                        "mf2": null,
                                        "mf3": null
                                    }}
                                }}
                            }}
                        ]
                    }},
                    "paymentMethods": [
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Bank Deposit" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Money Order" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/3", "name": "Cash on Delivery (COD)" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/4", "name": "Gift card" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/5", "name": "Deferred" }},
                        {{ "id": "gid://shopify/PaymentCustomizationPaymentMethod/6", "name": "(for testing) Bogus Gateway" }}
                    ],
                    "paymentCustomization": {{
                        "metafield": {{
                            "jsonValue": {{
                                "failSafe": false,
                                "rules": [
                                    {{
                                        "cartMatch": "any",
                                        "conditionLogic": "all",
                                        "conditions": [
                                            {{ "field": "tag", "operator": "equals", "value": "test-es", "metafieldSlot": -1 }}
                                        ],
                                        "action": "hide_selected",
                                        "targets": [
                                            {{ "pattern": "{}", "matchType": "{}" }}
                                        ]
                                    }}
                                ]
                            }}
                        }}
                    }}
                }}"#,
                pattern, match_type
            )
        };

        // Bank Deposit <-> Depósito Bancario (with or without tilde)
        for (pattern, match_type) in [
            ("Depósito Bancario", "exact"),
            ("Deposito Bancario", "exact"),
            ("Depósito", "contains"),
            ("deposito", "contains"),
            ("DEPOSITO", "contains"),
            ("bancario", "contains"),
            ("Bank Deposit", "exact"),
        ] {
            let res = run_function_with_input(
                cart_payment_methods_transform_run,
                &make_native_input(pattern, match_type),
            )?;
            assert_eq!(
                res.operations,
                vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/1")],
                "Expected Bank Deposit match for ({}, {})",
                pattern,
                match_type
            );
        }

        // Gateway payment methods and product title ignoring tildes (NFC & NFD)
        let tilde_gateway_and_title = r#"{
            "cart": {
                "lines": [
                    {
                        "cost": { "amountPerQuantity": { "amount": "100.00" } },
                        "merchandise": {
                            "__typename": "ProductVariant",
                            "sku": "VID-1",
                            "product": {
                                "id": "gid://shopify/Product/1",
                                "title": "El Videógrafo Snowboard",
                                "productType": "Snowboard",
                                "vendor": "Marca",
                                "hasTags": [],
                                "inCollections": [],
                                "mf0": null,
                                "mf1": null,
                                "mf2": null,
                                "mf3": null
                            }
                        }
                    }
                ]
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/10", "name": "Checkout Flow | Tarjeta. Transf., Cuotas débito" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/11", "name": "CUOTAS DE\u0301BITO" }
            ],
            "paymentCustomization": {
                "metafield": {
                    "jsonValue": {
                        "failSafe": false,
                        "rules": [
                            {
                                "cartMatch": "any",
                                "conditionLogic": "all",
                                "conditions": [
                                    { "field": "title", "operator": "contains", "value": "videografo", "metafieldSlot": -1 }
                                ],
                                "action": "hide_selected",
                                "targets": [
                                    { "pattern": "cuotas debito", "matchType": "contains" }
                                ]
                            }
                        ]
                    }
                }
            }
        }"#;
        let tilde_res = run_function_with_input(
            cart_payment_methods_transform_run,
            tilde_gateway_and_title,
        )?;
        assert_eq!(
            tilde_res.operations,
            vec![
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/10"),
                hide_op("gid://shopify/PaymentCustomizationPaymentMethod/11"),
            ]
        );

        // Money Order <-> Giro postal
        for (pattern, match_type) in [("Giro postal", "exact"), ("Giro", "contains")] {
            let res = run_function_with_input(
                cart_payment_methods_transform_run,
                &make_native_input(pattern, match_type),
            )?;
            assert_eq!(
                res.operations,
                vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/2")]
            );
        }

        // Cash on Delivery (COD) <-> Pago contra entrega
        for (pattern, match_type) in [
            ("Pago contra entrega (COD)", "exact"),
            ("Pago contra entrega", "contains"),
        ] {
            let res = run_function_with_input(
                cart_payment_methods_transform_run,
                &make_native_input(pattern, match_type),
            )?;
            assert_eq!(
                res.operations,
                vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/3")]
            );
        }

        // Gift card <-> Tarjeta de regalo
        let gift = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_native_input("Tarjeta de regalo", "exact"),
        )?;
        assert_eq!(
            gift.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/4")]
        );

        // Deferred <-> Pago diferido
        let deferred = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_native_input("Pago diferido", "exact"),
        )?;
        assert_eq!(
            deferred.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/5")]
        );

        // (for testing) Bogus Gateway <-> Pasarela simulada
        let bogus = run_function_with_input(
            cart_payment_methods_transform_run,
            &make_native_input("Pasarela simulada", "contains"),
        )?;
        assert_eq!(
            bogus.operations,
            vec![hide_op("gid://shopify/PaymentCustomizationPaymentMethod/6")]
        );

        Ok(())
    }
}
