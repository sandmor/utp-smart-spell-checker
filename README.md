# UTP Smart Spell Checker

Esta es una aplicación de corrección ortográfica inteligente con una interfaz de editor de texto moderna y sugerencias contextuales, alimentada por el algoritmo de Peter Norvig y alojada localmente usando Flask. La aplicación puede ser compilada para Android utilizando Kivy y Buildozer.

## Motor de Corrección en Español

El corrector usa una variante del algoritmo de Peter Norvig ajustada para español. Las mejoras específicas del idioma están activadas por defecto porque el foco del proyecto es español, pero están separadas detrás de la bandera `SPANISH_NORVIG_FEATURES`.

Para desactivar estas mejoras y volver al comportamiento Norvig plano:

```bash
SPANISH_NORVIG_FEATURES=0 uv run python main.py
```

Con la bandera activa, el motor agrega:

- **Distancia de edición ponderada con conciencia fonética:** no todos los cambios cuestan lo mismo. Confusiones frecuentes en español como `b/v`, `c/s/z`, `y/ll` y la `h` muda tienen una penalización menor que reemplazos no relacionados.
- **Tolerancia a tildes y diéresis:** diferencias como `cancion` frente a `canción` o `pinguino` frente a `pingüino` tienen un costo casi nulo en el ranking, por lo que no se tratan como errores fuertes frente a cambios de letra reales.
- **Separación de afijos:** para evitar depender únicamente de una lista plana enorme de frecuencias, el motor aplica un stripping ligero de sufijos españoles con reglas conservadoras. Si una forma flexionada no aparece directamente en el corpus pero su lema probable sí aparece con evidencia suficiente, la palabra puede aceptarse o recibir una probabilidad de respaldo. Las reglas débiles, como plurales simples, se usan para validar formas escritas pero no para fabricar candidatos de corrección de forma masiva.

Estas reglas no reemplazan el corpus `backend/crea_processed.txt`; lo complementan. La frecuencia del corpus sigue siendo la base de `P(c)`, y las reglas españolas ajustan la generación y el ranking de candidatos.

### Corpus

El corpus principal empaquetado por la aplicación es `backend/crea_processed.txt`, generado desde `backend/CREA_total.TXT`. `CREA_total.TXT` corresponde a una tabla de frecuencias del Corpus de Referencia del Español Actual (CREA) de la Real Academia Española.

El archivo raw de CREA usa codificación Latin-1 y columnas formateadas (`orden`, `palabra`, `frecuencia absoluta`, `frecuencia normalizada`). Para convertirlo al formato rápido de carga de la aplicación:

```bash
python scripts/preprocess_crea.py
```

El script escribe una lista UTF-8 `palabra frecuencia`, una entrada por línea. Durante la conversión conserva palabras alfabéticas, incluidas formas extranjeras que pueden aparecer en textos válidos, y descarta entradas con números, guiones, apóstrofos u otra puntuación porque el editor corrige tokens alfabéticos.

Como cualquier corpus real incluye erratas de baja frecuencia, el motor separa dos decisiones:

- Para sugerencias generadas, una palabra debe aparecer al menos 10 veces para contar como candidata confiable. Este umbral se puede ajustar con `SPELLCHECKER_MIN_KNOWN_COUNT`.
- Para palabras escritas exactamente por el usuario, las formas raras se aceptan si no parecen una confusión barata de una palabra mucho más frecuente. La relación de frecuencia usada para esta sospecha se puede ajustar con `SPELLCHECKER_TYPO_FREQUENCY_RATIO`.
- Las variantes ortográficas de bajo costo, como tildes omitidas o `n/ñ`, pueden imponerse incluso si la forma sin marca aparece en el corpus. La relación de frecuencia usada para preferir la variante marcada se puede ajustar con `SPELLCHECKER_ORTHOGRAPHIC_FREQUENCY_RATIO`.

En Android se empaqueta `backend/crea_processed.txt`; los archivos raw (`backend/CREA_total.TXT`, `backend/big.txt`) se excluyen del APK.

## Requisitos

- Python 3.10+
- `uv` para manejo de dependencias

## Ejecutar en Desarrollo

Para ejecutar el servidor Flask y la interfaz web localmente:

```bash
uv run python main.py
```

Esto iniciará el servidor Flask en `http://127.0.0.1:5000` y abrirá tu navegador automáticamente.

## Compilar para Android (APK)

Este proyecto está configurado para ser compilado en un archivo `.apk` instalable para Android utilizando Buildozer.

### Pasos para Compilar

1. Asegúrate de estar en el directorio raíz del proyecto (donde se encuentra `buildozer.spec`).
2. Ejecuta el comando de construcción de Buildozer usando `uv`:

```bash
uv run buildozer android debug
```

> **Nota:** La primera vez que compiles, Buildozer descargará el SDK/NDK de Android y otras herramientas necesarias, por lo que puede tomar bastante tiempo (10-20 minutos dependiendo de tu conexión).

### Instalar y Ejecutar en tu Teléfono

Si tienes tu teléfono Android conectado por USB y con el **Modo de Depuración USB** activado, puedes compilar, instalar y ejecutar la aplicación en un solo paso con:

```bash
uv run buildozer android debug deploy run
```

Una vez instalada, la aplicación iniciará el servidor en segundo plano y abrirá tu navegador web predeterminado automáticamente.
