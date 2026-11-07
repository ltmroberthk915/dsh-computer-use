# Computer Use al estilo Codex

**La forma más precisa de controlar Windows desde DeepSeek Harness — y la más económica por tarea.**

Describa el objetivo. Su agente lee identidades exactas de controles, actúa a través de los propios controles, verifica el resultado y completa una secuencia conocida en una sola ronda de ida y vuelta del modelo en lugar de diez.

[English](README.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | **Español** | [Português](README.pt.md) | [العربية](README.ar.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) · [Instalar](#install-and-update-in-dsh-market) · [Registro de cambios](CHANGELOG.md) · [Novedades de 2.0.0](docs/RELEASE-2.0.0.md)

![Control de escritorio Windows al estilo Codex: observar, actuar, verificar](docs/images/01-codex-style.png)

## Por qué es la opción precisa

- **Identidad, no conjeturas.** UI Automation expone el árbol de controles real con `AutomationId` exactos, y las acciones pueden manejar un control mediante sus propios patrones de UI Automation en lugar de hacer clic en coordenadas.
- **Las marcas se verifican, no se dan por buenas.** De forma predeterminada, una marca numerada se valida contra la identidad de la ventana y los píxeles muestreados antes de enviar cualquier entrada, por lo que una marca obsoleta se rechaza en lugar de hacer clic con ella en el lugar equivocado. Cuando un vecino animado invalida continuamente la firma de píxeles, `uiaOnly` fija la identidad al identificador de ventana y a la geometría, mientras que la comprobación de oclusión en el momento del envío sigue aplicándose.
- **Las consultas se mantienen acotadas.** Las consultas UIA tienen como valores predeterminados profundidad 6, 120 nodos y un presupuesto flexible de 1200 ms; una consulta de más de 6 niveles de profundidad o de más de 300 nodos requiere un `anchor` medido, de modo que una consulta no pueda barrer silenciosamente la región equivocada.
- **Cuando la aplicación lo oculta, léalo.** `computer_ocr` devuelve líneas y cajas por palabra en píxeles absolutos de pantalla, por lo que las aplicaciones sin UIA se pueden localizar por nombre.

## Por qué cuesta menos

- **Una sola ronda de ida y vuelta para una secuencia conocida.** Una llamada a `computer_batch` ejecuta una lista de acciones en serie, se detiene en el primer fallo y cuesta una sola ronda de ida y vuelta del modelo en lugar de una por acción.
- **Solo vuelve el delta.** Pase el ID de observación anterior como `since` y reciba adiciones, cambios, eliminaciones y el orden, no el árbol completo otra vez.
- **Recibos compactos de forma predeterminada en 2.0.0.** El texto posterior a la acción normalmente añade como máximo 6 KiB al recibo de la acción; `feedback: full` sigue disponible cuando el detalle importa más.
- **La evidencia no entra en la conversación.** La evidencia completa de un punto puede residir en una caché local acotada (4 MiB de memoria, 32 MiB de disco, 64 registros, caducidad de 24 horas) y recuperarse cuando sea necesario.
- **El trabajo local se queda local.** UI Automation, el OCR de pantalla y las comprobaciones de píxeles se ejecutan en el worker nativo precompilado, sin coste adicional de visión por paso.

## Diseñado para un escritorio que usted sigue usando

- **Espera por usted.** Un aviso de 1 segundo antes de la entrada (0,1 segundos dentro de una ventana deslizante de 3 minutos) devuelve el escritorio de inmediato; cuando usted termina, el agente vuelve a observar y continúa la tarea original.
- **El freno llega al modelo.** `Ctrl+Esc` pausa, `Ctrl+Alt+R` reanuda, `Ctrl+Alt+Q` sale, y una detención se inyecta en la sesión en ejecución. Las aprobaciones se mantienen activadas de forma predeterminada y los campos de contraseña se rechazan de forma predeterminada.
- **Informa de lo que no puede hacer.** El escritorio seguro de Windows (aviso de UAC o pantalla de bloqueo) se detecta, se informa y se reanuda después; no se reintenta a ciegas.

![Traspaso a la persona: preparar, tomar el control, continuar](docs/images/02-handoff.png)

![Eficiencia de tokens: observaciones focalizadas, acciones por lotes y relectura de resultados](docs/images/03-token-efficiency.png)

Las ilustraciones anteriores muestran el modelo de interacción introducido en 1.3.0; el puntero en forma de cometa de 2.0.0, las consultas acotadas y los recibos compactos se describen arriba. El uso real de tokens depende de la tarea, el modelo y la estrategia de observación. Las aprobaciones permanecen activadas de forma predeterminada; la pausa, la cancelación y la salida explícitas siguen teniendo la última palabra.

**Listo para instalar.** 19 herramientas de escritorio, con los componentes nativos incluidos. Sin SDK ni compilación durante la instalación. Requiere Windows, Node.js ≥ 22 y .NET Framework 4.x, que se incluye con Windows. Un complemento comunitario independiente; Codex describe el estilo de interacción.

## Novedades de 2.0.0

- **Recibos compactos de forma predeterminada**: el texto posterior a la acción normalmente añade como máximo 6 KiB al recibo de la acción; `feedback: full` y `feedback: none` son alternativas explícitas.
- **Consultas UIA acotadas y ancladas**: profundidad 6, 120 nodos y un presupuesto flexible de 1200 ms de forma predeterminada; las consultas de más de 6 niveles de profundidad o de más de 300 nodos necesitan un `anchor` medido.
- **Evidencia bajo demanda**: 4 MiB de memoria + 32 MiB de disco, 64 registros, caducidad de 24 horas; un fallo de disco recurre a la memoria acotada.
- **Aviso de preparación adaptativo**: 1 segundo inicialmente, 0,1 segundos dentro de una ventana deslizante de 3 minutos; la cometa inclinada marca el punto de clic del agente.
- **Ruta de entrada reforzada**: combinaciones de teclas protegidas para la gestión de ventanas, contrapresión y recuperación del worker, comprobaciones de destinos obsoletos y limpieza tras cancelación.

<details>
<summary>Versión actual y compatibilidad</summary>

**2.0.0** es la nueva versión principal, distribuida inicialmente en npm `next` mientras transcurre el período de espera de publicación de 24 horas. Consulte [cambios y migración de 2.0.0](docs/RELEASE-2.0.0.md). Compruebe las etiquetas del registro para conocer la disponibilidad estable actual.

La versión 1.3.1 lee texto de la pantalla por nombre, detecta el escritorio seguro de Windows y se reanuda por sí sola, y mantiene todos los colores en el mismo riel de borde derivado del DPI, con un nivel mínimo de respiración visible. La versión 1.3.0 libera el control del escritorio cuando el trabajo termina mientras el chat continúa.

Correcciones anteriores: [atribución de aprobaciones 1.2.3](docs/RELEASE-1.2.3.md) · [atención nativa 1.2.1](docs/RELEASE-1.2.1.md) · [parche de host independiente](docs/RELEASE-1.2.2.md).

</details>

## Qué hace

La versión 2.0.0 también utiliza un puntero de cometa azul y compacto durante la operación de la IA y la retención de escena. Su punta inclinada marca el punto de clic, con pequeños símbolos de texto y de cambio de tamaño dentro de la cometa. Una cometa que respira indica que la página y la posición del puntero deben permanecer en su sitio; el modo libre restaura el cursor normal de la aplicación. Se conserva el tema de cursor de Windows del usuario.

La versión 2.0.0 acota el recorrido de UIA y usa de forma predeterminada texto compacto posterior a la acción. La retroalimentación de imágenes existente sigue disponible; `feedback: compact|full|none` controla el detalle, y `verificationRegion: "x,y,w,h"` designa, en el clic, el área de efecto esperada con independencia del punto de entrada. El texto compacto normalmente añade como máximo 6 KiB al recibo de acción original. La evidencia completa del punto se puede conservar en una caché local acotada y con caducidad, y recuperarse bajo demanda. Un fallo de disco recurre a la memoria acotada; si no se puede conservar ninguna instantánea recuperable, la evidencia actual se devuelve en línea y completa, fuera de ese presupuesto compacto, sin otra observación ni entrada.

Las consultas UIA filtradas requieren `hwnd`. Los valores predeterminados son profundidad 6, 120 nodos y un presupuesto flexible de 1200 ms. Una consulta de más de 6 niveles de profundidad o de más de 300 nodos requiere un `anchor:"x,y"` medido en esa ventana; un `id` exacto no elude esta regla. Una llamada al proveedor puede superar el presupuesto flexible, y los resultados parciales no pueden demostrar ausencia ni unicidad. Tras un atajo de gestión de ventanas, inspeccione `computer_state {windows:true}`, active correctamente la ventana deseada y, después, obsérvela antes de introducir más entrada de teclado.

- **Observar**: lista de ventanas, capturas de pantalla (región / JPEG / PNG / reducidas), un mapa Set-of-Marks de
  elementos en los que se puede hacer clic y el árbol de UI Automation con `AutomationId` exactos.
- **Actuar**: hacer clic, mover, arrastrar, desplazar, seleccionar un rango de texto, escribir, pulsar teclas y accionar controles
  mediante sus propios patrones de UI Automation en lugar de coordenadas a ciegas.
- **Lote**: una llamada a `computer_batch` ejecuta una lista de acciones en serie y se detiene en el primer
  fallo, de modo que una secuencia conocida cuesta una ronda de ida y vuelta del modelo en lugar de diez.
- **Preguntar**: `computer_ask` plantea una pregunta en la misma tarjeta de chat que DSH usa para `ask_user_question`,
  sin cuenta atrás.
- **Un freno humano que llega al modelo**: una detención se inyecta en la sesión en ejecución, de modo que el agente
  se entera de que fue interrumpido en lugar de descubrirlo en el siguiente turno.

Las herramientas observan el escritorio en lugar de rastrear los documentos del usuario. El complemento gestiona los componentes nativos en
`%LOCALAPPDATA%\dsh-computer-use\worker\`, y los registros de auditoría, las capturas de pantalla y su propia caché acotada
`observation-cache` en `$DSH_HOME/data/computer-use/`. `computer_ctrl {action:"clear_cache"}` borra
la caché de observaciones de este Agente; no elimina capturas de pantalla, archivos adjuntos ni documentos del usuario.

<a id="install-and-update-in-dsh-market"></a>

## Instalación y actualización en dsh-market

Busque **computer-use** o **Codex-style** en el mercado. Localice el repositorio **ltmroberthk915/dsh-computer-use** y el paquete npm **dsh-codex-style-computer-use** (mantenedor: **ltmroberthk**) y, después, haga clic en **Instalar**. Use **Actualizar** o **Actualizar todo** para las actualizaciones del canal estable. Ambos componentes nativos están incluidos; no se necesita PowerShell 7 ni permiso de compilación.

Como alternativa, introduzca **`dsh-codex-style-computer-use`** en **Ajustes → Complementos → Añadir complemento** para el canal estable actual, o **`dsh-codex-style-computer-use@2.0.0`** para la versión que se describe aquí. Introduzca la especificación del paquete npm directamente. Es posible que su host aplique un período de espera a las versiones nuevas; siga sus indicaciones. Un bundle recién añadido puede cargarse en vivo en los hosts compatibles; compruebe que aparecen sus herramientas y su skill. Reinicie desde la bandeja del sistema cuando reemplace una versión ya cargada, cuando el cliente siga desactualizado o cuando DSH indique **restart-required**.

### Versiones publicadas hace menos de 24 horas

La configuración predeterminada no estricta de pnpm 11.7.0 registra automáticamente una excepción de una sola versión e instala. Una instalación correcta en una máquina no demuestra que otra máquina permita versiones nuevas.

Con `minimumReleaseAgeStrict: true` (o una política del host que active comprobaciones estrictas de antigüedad de versiones), y sin una excepción aplicable, una versión por debajo de la antigüedad configurada se rechaza antes de que se ejecute el código del complemento. Se verificó que el nombre simple, una fijación exacta `@1.2.0` y la URL del tarball de npm fallan con `ERR_PNPM_NO_MATURE_MATCHING_VERSION` bajo esa política. Establecer explícitamente `minimumReleaseAge: 1440` también activa el comportamiento estricto en pnpm 11.7.0, a menos que `minimumReleaseAgeStrict` se establezca por separado en false. Reiniciar DSH, instalar PowerShell o reintentar el mismo comando no corrige un rechazo por política estricta. El puente de escritorio oficial no acepta opciones adicionales de pnpm.

Si una política estricta bloquea la instalación, espere a que la versión cumpla la antigüedad configurada para instalar sin cambiar la política. La versión 1.2.0 se publicó en `2026-10-03T03:50:11.586Z`; cumple el umbral de 24 horas a partir de **2026-10-04 03:50:12 UTC** (11:50:12 en China). Un umbral personalizado más largo o un espejo de registro con retraso pueden demorar aún más la disponibilidad. Los usuarios de la configuración predeterminada no estricta no necesitan esperar ni editar la configuración para este paquete.

Si elige explícitamente instalar antes, combine esta excepción de una sola versión en el `pnpm-workspace.yaml` existente del perfil de destino y, después, reintente la instalación desde el mercado. Conserve las demás entradas; no desactive la política global de antigüedad:

```yaml
minimumReleaseAgeExclude:
  - dsh-codex-style-computer-use@1.2.0
```

La ruta de escritorio predeterminada es `%USERPROFILE%\.dsh\profiles\desktop\pnpm-workspace.yaml`; use el directorio real si `DSH_HOME` está personalizado. Elimine esta única excepción cuando la versión madure, si lo desea.

Las correcciones anteriores de documentación y de comprobación del publicador no cambiaron el runtime de 1.2.0 y no requirieron reinstalación. La corrección de atención nativa de **1.2.1** sí requiere una actualización. Volver a añadir la misma fuente puede producir un error `ambiguous-install` del host en algunas rutas de instalación; reinstalar 1.2.0 no aplicará la corrección de 1.2.1.

**Migración de una instalación anterior por Git/tarball desde este repositorio:** elimine la entrada antigua **dsh-computer-use** del mercado y, después, instale **dsh-codex-style-computer-use**. El nombre npm sin ámbito `dsh-computer-use` pertenece a otro repositorio; no lo instale como actualización de este complemento. Una instalación por Git no puede cambiar la identidad de su dependencia solo con obtener un nuevo commit. Después de esta migración única en la interfaz, use las actualizaciones normales del mercado. Se conservan los nombres de herramientas `computer_*` existentes y el espacio de nombres de ajustes `computer-use`.

**Conserve también su configuración guardada:** haga una copia de seguridad del `cordis.patch.yml` del perfil y, después, cambie solo `name: dsh-computer-use` por `name: dsh-codex-style-computer-use` en una anulación con `id: computer-use`. Mantenga todos sus campos `config` y `disabled`. Conservar solo el espacio de nombres de ajustes no basta: una discrepancia de nombre hace que DSH omita incluso las anulaciones `read-only`, `dryRun` y de estado deshabilitado. No reemplace otros complementos ni un parche compartido del home de forma global. El script `scripts/migrate-profile.mjs` del repositorio hace una vista previa de forma predeterminada; `--apply` crea una copia de seguridad y reemplaza el archivo de forma atómica, y rechaza ediciones simultáneas.

Como alternativa, descargue la [utilidad de migración de configuración](https://github.com/ltmroberthk915/dsh-computer-use/releases/download/v1.2.0/computer-use-profile-migration.zip), extráigala y haga doble clic en `migrate-profile.cmd`. Localiza la aplicación oficial de escritorio instalada y usa Windows PowerShell 5.1 y el Node incluido en DSH para reparar el perfil de escritorio predeterminado. Se detiene si el bundle nuevo no está presente o si el bundle antiguo sigue seleccionado. No cambia la política de antigüedad de versiones. Para otro perfil, ejecute `migrate-profile.ps1 -ProfileDirectory <absolute-directory>` para ver una vista previa y, cuando esté listo, añada `-Apply`.

La versión publicada en GitHub también incluye `dsh-computer-use.tgz` para instalación sin conexión o manual; la instalación desde el registro es la opción predeterminada para las actualizaciones del mercado.

Usuarios de la CLI (perfil web):

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

Los diagnósticos de escritorio deben usar la **CLI incluida con la aplicación oficial de escritorio**:

```powershell
$CuDshInstall = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
& "$CuDshInstall\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop why dsh-codex-style-computer-use
```

Para una instalación personalizada, establezca `$CuDshInstall` en el directorio del destino del acceso directo de escritorio. Un `dsh` global de npm más antiguo puede rechazar el perfil de escritorio. No añada `resources/runtime/bin` al PATH global ni instale un pnpm independiente para esta tarea. Para la instalación, prefiera la interfaz del complemento.

## El skill incluido

Las herramientas de control permanecen bloqueadas hasta que la sesión produce una frase de recibo que existe solo dentro de
`skills/computer-use/SKILL.md`. Eso es deliberado: es la versión honesta más sólida de «leer el
manual antes de controlar», porque ninguna capa de herramientas puede ver si un modelo leyó un documento.

El complemento registra el skill incluido mediante `ctx.skills.register()` cuando está disponible. Si ese servicio no está disponible, `computer_use_activate` devuelve el mismo manual, su ruta de origen absoluta y la lista de herramientas con ámbito. El recibo y todas las comprobaciones de aprobación y freno existentes siguen aplicándose.

## Entrada compartida en 1.2.0-rc.2

Esta versión preliminar introduce la toma de control humana inmediata, la espera automática tras 2 segundos de entrada continua y la continuación tras 3 segundos de inactividad. La espera ocurre localmente, sin sondeo del modelo. Las escrituras interrumpidas requieren una nueva lectura de verificación y nunca se reproducen a ciegas. La cancelación del host libera la entrada aceptada propiedad de la automatización sin crear una nueva pausa persistente. Se conserva el manejo existente de DSH Pet y la ventana principal, así como del topmost original.

Las rutas configuradas GLM 5.3 Max, GLM 5.3 Flash y DeepSeek Flash superaron una prueba controlada del protocolo de continuación. La entrada nativa y las teclas de acceso rápido físicas se verificaron por separado; esto no es una evaluación general de escritorio ni de visión. Consulte la [verificación de la versión](docs/RELEASE-1.2.0-rc.2.md) para conocer el alcance.

## Controles bajo demanda en 1.1

- **Herramientas por Agente:** los Agentes inactivos ven `computer_use_activate`, `computer_ctrl` y `computer_ask`. Una carga correcta del skill computer-use, un recibo o una activación exponen a ese Agente las 19 herramientas de escritorio más la entrada de activación. Otros Agentes y los agentes hijos se activan de forma independiente. Se admiten llamadas nativas y `run_code` de Node. La activación no inicia el control ni libera un freno humano.
- **Destinos UIA observados:** una consulta de nombre/id con ámbito devuelve un identificador de destino opaco. Úselo para acciones de patrón; `rebind:true`, opcional, permite la recuperación por identidad única o semántica después de un reemplazo en la misma ventana. Un contexto cambiado, la ambigüedad y los escaneos incompletos provocan un rechazo. Las consultas amplias omiten los identificadores de recuperación a menos que `targets:true`; crear testigos para una lista grande cuesta trabajo nativo adicional.
- **Observaciones incrementales:** pase el ID de observación anterior como `since` con la misma consulta. Los deltas conservan adiciones, cambios, eliminaciones y el orden. Las instantáneas están aisladas por Agente, con un máximo de 64 observaciones indexadas y 4 MiB de JSON retenido por almacén. `snapshot` recupera un resultado histórico retenido; `offset` y `limit` paginan sus matrices. Las bases ausentes, el ámbito cambiado, la evidencia incompleta o un delta mayor recurren a la salida completa.

Consulte [el protocolo detallado](skills/computer-use/references/progressive-control.md) para conocer los límites de la caché y los límites de recuperación. Las instantáneas UIA conservan los campos devueltos por el proveedor dentro de los límites existentes del proveedor; la recuperación histórica no es una verificación reciente del resultado.

## Herramientas

| Grupo | Herramientas |
|---|---|
| Activar | `computer_use_activate` |
| Observar | `computer_state` `computer_shot` `computer_ocr` `computer_marks` `computer_uia` |
| Actuar | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| Flujo | `computer_wait` `computer_batch` |
| Meta | `computer_ask` `computer_ctrl` |

`computer_marks` devuelve marcas numeradas para los elementos que encontró en pantalla; `computer_marks {shot:true}` también guarda una imagen anotada. `computer_shot` devuelve una captura de pantalla simple y, en rutas compatibles con imágenes, un adjunto de imagen nativo. Una marca es un ID de instantánea: se valida contra la identidad de la ventana
y los píxeles muestreados antes de enviar cualquier entrada, por lo que una marca obsoleta se rechaza en lugar de
hacer clic con ella en el lugar equivocado.

## Modos de aprobación

Para un host que informa un rechazo automático por avisos deshabilitados como «el usuario rechazó la herramienta», consulte el [parche de atribución de aprobaciones de DSH y la prueba de regresión](docs/APPROVAL-ATTRIBUTION.md).

`automationMode` se establece en los ajustes del complemento y su valor predeterminado es `standard`:

| Modo | Observación | Actuación |
|---|---|---|
| `read-only` | permitida | denegada |
| `standard` | permitida | cada acción se solicita mediante la tarjeta de aprobación del host |
| `autonomous` | permitida | permitida, las operaciones de alto riesgo siguen solicitando aprobación |
| `unrestricted` | permitida | permitida (el mecanismo de seguridad y el límite de frecuencia del worker siguen aplicándose) |

Las operaciones de alto riesgo (cerrar una ventana, `alt+f4`, `win+r` y similares) solicitan aprobación en todos los modos. Los campos
de contraseña se detectan mediante `IsPassword` de UI Automation y se rechazan de forma predeterminada.

## Modelo de seguridad

- **Entrada compartida**: la actividad normal del usuario está permitida mientras el agente piensa, observa o se prepara. Durante la actuación real, la escritura, el desplazamiento y los botones ceden de inmediato; el movimiento del puntero tiene una tolerancia de desplazamiento de 16 píxeles. La entrada continua o mantener una tecla o un botón durante 2 segundos activa la espera automática. Tras soltar y 3 segundos de inactividad, el agente debe inspeccionar el destino actual y continuar la tarea original, sin reproducir a ciegas escrituras parciales. Un suave degradado de borde en amarillo pálido indica que el control es humano.
- **Pausa manual**: solo la combinación física `Ctrl+Esc` activa un freno de entrada persistente; `Ctrl+Alt+R` lo reanuda. La tecla Esc normal, la escritura, el desplazamiento, la distancia y la frecuencia del puntero y la esquina de la pantalla no crean esta pausa. Las retenciones explícitas por pregunta o diagnóstico siguen siendo independientes.
- **Salida**: `Ctrl+Alt+Q` finaliza la sesión: la superposición desaparece, sus listeners se desmontan y
  se rechaza cualquier actuación posterior hasta que un turno posterior abra una nueva.
- **El freno es un hecho de la máquina, no de un solo proceso**: el estado activado se conserva y
  cada worker lo adopta, incluido uno iniciado más tarde desde un shell.
- **Auditoría**: cada actuación se anexa a `$DSH_HOME/data/computer-use/audit.jsonl` con saneamiento de
  argumentos.
- **Interruptor de emergencia del propio complemento**: `DSH_COMPUTER_USE_KILL=1` hace que el complemento se niegue a iniciarse;
  `dryRun: true` simula las actuaciones y solo las registra.

## Configuración

| Clave | Valor predeterminado | Significado |
|---|---:|---|
| `automationMode` | `standard` | modo de aprobación (arriba) |
| `progressiveTools` | `true` | activación por Agente; `false` expone las 19 herramientas de escritorio de forma global |
| `actionFeedback` | `true` | observar automáticamente después de acciones directas y lotes |
| `actionFeedbackDetail` | `compact` | `compact`, `full` o `none`; el `feedback` de una llamada anula este valor predeterminado; la evidencia no almacenada en caché recurre a la salida completa en línea |
| `dryRun` | `false` | simular actuaciones, solo registrar |
| `maxActionsPerMinute` | `60` | límite de frecuencia de actuación a nivel del núcleo |
| `annotateMarks` | `true` | dibujar cajas Set-of-Marks en las capturas de pantalla |
| `workerExe` | `""` | ruta explícita del worker; vacío = autodescubrir o compilar |
| `snapshotDir` | `""` | directorio de capturas de pantalla; vacío = `$DSH_HOME/data/computer-use/shots` |

## Servidor MCP

`mcp/` es un servidor MCP stdio sin dependencias sobre el mismo núcleo, para clientes que hablan MCP en lugar
de Cordis:

```sh
node mcp/src/index.js
```

El servidor integrado informa de la versión de este paquete raíz. Se inicia solo con observación.
El host que lo lanza puede establecer `DSH_CU_ALLOW_INPUT=1` cuando posee la autorización para las acciones de escritorio;
las llamadas a herramientas MCP no pueden habilitar la entrada. La herramienta de compatibilidad `cu_approve` solo informa de esta regla y
nunca concede consentimiento. La política `automationMode` de DSH pertenece al adaptador de Cordis y no es un
servicio de aprobación MCP. `DSH_CU_DRY_RUN=1` simula la entrada que el host ya ha habilitado.

Ambos adaptadores usan la misma gramática de comandos de teclas, las mismas reglas de fallo y continuación de lotes, y la misma asignación
de coordenadas de imagen. MCP devuelve metadatos de captura estructurados y una única imagen PNG/JPEG más reciente, sin
serializar los bytes de la imagen en texto JSON. `cu_hold` / `cu_free` reservan o liberan la escena entre
acciones; `cu_release` finaliza el ciclo de escritorio. `cu_drag` acepta comprobaciones `expectCursor` y `hwnd`.
MCP expone una superficie de herramientas más pequeña; el adaptador de Cordis proporciona la integración específica de DSH
para preguntas humanas y el ciclo de vida del host.

## Desarrollo

Las comprobaciones de publicación del publicador usan el registro oficial de npm de forma predeterminada. Si ese origen no es accesible en su red, `CU_REGISTRY` selecciona un espejo explícito para el comando `check` de solo lectura; el resultado JSON incluye `registry` y `authoritative`. Ejemplo en PowerShell (esto solo cambia el shell actual):

```powershell
$env:CU_REGISTRY = 'https://registry.npmmirror.com'
node scripts/release-channel.mjs check 1.2.0
Remove-Item Env:CU_REGISTRY
```

El código de salida `0` significa que la versión ha superado la comprobación de publicación de 24 horas, `2` significa que aún está en período de enfriamiento y `1` significa que la comprobación falló. Un fallo de red no demuestra que un paquete no esté publicado, y los espejos pueden ir con retraso. `promote` siempre vuelve a comprobar y escribe en `https://registry.npmjs.org`, ignorando `CU_REGISTRY`; necesita acceso a ese origen y usa la configuración de proxy de npm cuando es necesario. Esta herramienta del publicador no forma parte de la instalación para el usuario final. Consulte [el procedimiento de publicación](docs/RELEASE-1.2.0.md).

El repositorio incluye la suite de guardas que protege las invariantes anteriores: la vida útil del ciclo, el
protocolo de pregunta y freno, la clasificación de operaciones, la puerta del skill y el cableado del skill incluido:

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # all guards
node build/verify-tools-schema.mjs                                   # tool-schema load guard
```

Las definiciones de herramientas se compilan mediante el DSL real `@deepseek-ai/dsh-tools`, de modo que un error de esquema
falla aquí en lugar de derribar el árbol de complementos del host al reiniciar. Algunas guardas compilan el
worker nativo y son exclusivas de Windows.

## Licencia

MIT — consulte [LICENSE](LICENSE).
