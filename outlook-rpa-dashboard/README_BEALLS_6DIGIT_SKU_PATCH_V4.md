# Patch v4 - Bealls 6 digit SKU line reader

Este patch corrige el parser de Bealls para leer POs donde la tabla de items trae SKU de 6 dígitos, por ejemplo:

```txt
159544  AB101-42-  Black  .  NYLON DIAMOND QUILT DUFFLE BAG  $9.00  908
003
```

Antes el parser buscaba SKU de 7 a 12 dígitos y por eso el header/totales salían bien, pero `line_count` quedaba en 0.

## Archivo modificado

```txt
api/src/po/parsers/bealls.js
```

## Resultado esperado con PO 1902633

```txt
parser: bealls
order_no: 1902633
line_count: 5
totals.qty: 3375
totals.amount: 30375
```

El parser sigue soportando los formatos Bealls anteriores con SKU largos.
