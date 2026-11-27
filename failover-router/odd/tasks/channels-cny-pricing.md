# Channels CNY input pricing
Normalize marketplace input prices to CNY in the router and label cheap Channels rows with the per-million input unit.

## Specs
1. S1: “Quiero que ser transformen todas a CNY que es la moneda que utilizo por defecto para estos casos.”
2. S2: “Investiga si se puede solicitar vía api a SubRouter directamente en esta moneda para no tener que hacer el cambio, en caso de que no se pueda obten el precio en USD y cambia a CNY.”
3. S3: “Indica también en la pestaña que los precios son el valor del precio del input de ese canal con el texto "M in"”

## Tasks
- T1 | S1-S2 | inline | commit: pending — Normalize native marketplace prices to CNY using the established USD→CNY rate and retain dynamic hourly refresh behavior.
- T2 | S3 | inline | commit: pending — Render cheap prices with the CNY symbol and `M in` unit; update contract fixtures/docs.
- T3 | S1-S3 | inline | commit: pending — Run focused/full tests and integration verification.

## Log
L1: Veo que los precios se muestran en distintas monedas, unas en CNY y otras en USD. Quiero que ser transformen todas a CNY que es la moneda que utilizo por defecto para estos casos. Investiga si se puede solicitar vía api a SubRouter directamente en esta moneda para no tener que hacer el cambio, en caso de que no se pueda obten el precio en USD y cambia a CNY. Indica también en la pestaña que los precios son el valor del precio del input de ese canal con el texto "M in"
L2: Investigation found no usable SubRouter public currency parameter; client-side conversion is required. Current SubRouter guidance establishes USD→CNY at 6.8 and native CNY values remain unchanged.
