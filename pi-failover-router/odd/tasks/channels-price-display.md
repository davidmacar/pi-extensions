# Channels fast/cheap price display
Implement distinct fast and cheap virtual-model sections in the Channels card, with current speed measurements and current three cheapest prices for Sol and DeepSeek.
This feature spans the router snapshot and the Gentle Shell Channels patch; preserve unrelated working-tree changes and do not publish.

## Specs
1. S1: “dentro de Channels deberá hacerse distinción entre los dos modelos virtuales configurados para cada variante de sol y de deepseek, una para rápido y otro para barato”
2. S2: “En la sección de rápido deberá mostrarse la información que ya se muestra de velocidad de canales y el canal seleccionado”
3. S3: “en la sección de barato deberá aparecer los 3 canales más baratos para sol y para deepseek junto a sus precios calculados (esto se actualiza dinámicamente, recuerda) y el modelo que se está seleccionando para el respectivo modelo virtual de barato”

## Tasks
- T1 | S1-S3 | inline | commit: pending — Extend router snapshot with separate virtual fast/cheap variants and price-ranked rows from the dynamic cache.
- T2 | S1-S3 | inline | commit: pending — Extend Channels card contract, validation, rendering, integration verification, and docs.
- T3 | S1-S3 | inline | commit: pending — Run focused tests, package suite, and patch/card checks; inspect resulting diff.

## Log
L1: Quiero que la tool de Channels que se muestra en PI con la información actualizada de la velocidad de los modelos muestre también el precio de los 3 modelos más baratos actualizados para sol y para deepseek, de esta manera, dentro de Channels deberá hacerse distinción entre los dos modelos virtuales configurados para cada variante de sol y de deepseek, una para rápido y otro para barato. En la sección de rápido deberá mostrarse la información que ya se muestra de velocidad de canales y el canal seleccionado y en la sección de barato deberá aparecer los 3 canales  más baratos para sol y para deepseek junto a sus precios calculados (esto se actualiza dinámicamente, recuerda) y el modelo que se está seleccionando para el respectivo modelo virtual de barato
L2: Human authorized reading and editing ../patches/gentle-pi-channels; preserve pre-existing dirty working tree changes and do not publish.
