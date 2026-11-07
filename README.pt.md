# Computer Use no estilo Codex

**A forma mais precisa de controlar o Windows a partir do DeepSeek Harness — e a de menor custo por tarefa.**

Descreva o objetivo. Seu agente lê as identidades exatas dos controles, age por meio dos próprios controles, verifica o resultado — e conclui uma sequência conhecida em uma única rodada do modelo, em vez de dez.

[English](README.md) | [中文](README.zh.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Português** | [العربية](README.ar.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) · [Instalar](#install-and-update-in-dsh-market) · [Registro de alterações](CHANGELOG.md) · [Novidades da 2.0.0](docs/RELEASE-2.0.0.md)

![Controle de desktop do Windows no estilo Codex: observar, agir, verificar](docs/images/01-codex-style.png)

## Por que ele é o mais preciso

- **Identidade, não adivinhação.** O UI Automation expõe a árvore real de controles com `AutomationId`s exatos, e as ações podem acionar um controle por meio de seus próprios padrões de UI Automation, em vez de clicar em coordenadas.
- **Marcas são verificadas, não presumidas.** Por padrão, uma marca numerada é validada com base na identidade da janela e em pixels amostrados antes de qualquer entrada ser enviada, de modo que uma marca obsoleta é recusada em vez de clicada no lugar errado. Quando um vizinho animado continua invalidando a assinatura de pixels, `uiaOnly` fixa a identidade ao handle da janela e à geometria, enquanto a verificação de oclusão no momento do envio continua se aplicando.
- **As consultas permanecem limitadas.** As consultas UIA usam por padrão profundidade 6, 120 nós e um orçamento flexível de 1200 ms; uma consulta com profundidade maior que 6 ou mais de 300 nós exige um `anchor` medido, para que uma consulta não varra a região errada silenciosamente.
- **Quando o app esconde, leia.** `computer_ocr` retorna linhas e caixas por palavra em pixels absolutos da tela, de modo que aplicativos sem UIA podem ser localizados pelo nome.

## Por que ele custa menos

- **Uma rodada para uma sequência conhecida.** Uma chamada `computer_batch` executa uma lista de ações em série, para na primeira falha e custa uma única rodada do modelo em vez de uma por ação.
- **Só o delta retorna.** Informe o ID da observação anterior como `since` e receba adições, alterações, remoções e ordenação — não a árvore inteira de novo.
- **Recibos compactos por padrão na 2.0.0.** O texto pós-ação normalmente acrescenta no máximo 6 KiB ao recibo da ação; `feedback: full` continua disponível quando o detalhe importa mais.
- **As evidências ficam fora da conversa.** A evidência completa do ponto pode residir em um cache local limitado (4 MiB de memória, 32 MiB de disco, 64 registros, expiração em 24 horas) e ser obtida sob demanda.
- **O trabalho local permanece local.** UI Automation, OCR de tela e verificações de pixels são executados no worker nativo pré-compilado — sem custo extra de visão por etapa.

## Feito para um desktop que você ainda usa

- **Ele espera por você.** Um aviso de 1 segundo antes da entrada (0,1 segundo dentro de uma janela móvel de 3 minutos) devolve o desktop imediatamente; depois que você termina, o agente observa novamente e continua a tarefa original.
- **O freio chega ao modelo.** `Ctrl+Esc` pausa, `Ctrl+Alt+R` retoma, `Ctrl+Alt+Q` encerra, e uma parada é injetada na sessão em execução. As aprovações permanecem ativadas por padrão e campos de senha são recusados por padrão.
- **Ele relata o que não consegue fazer.** O desktop seguro do Windows (prompt do UAC ou tela de bloqueio) é detectado e relatado, e a tarefa é retomada em seguida — sem novas tentativas às cegas.

![Passagem ao humano: preparar, assumir, continuar](docs/images/02-handoff.png)

![Eficiência de tokens: observações focadas, ações em lote e leitura dos resultados](docs/images/03-token-efficiency.png)

As ilustrações acima mostram o modelo de interação introduzido na 1.3.0; o ponteiro de pipa da 2.0.0, as consultas limitadas e os recibos compactos estão descritos acima. O uso real de tokens depende da tarefa, do modelo e da estratégia de observação. As aprovações continuam ativadas por padrão; pausa, cancelamento e saída explícitos continuam prevalecendo.

**Pronto para instalar.** 19 ferramentas de desktop, com helpers nativos incluídos. Sem SDK nem compilação no momento da instalação. Requer Windows, Node.js ≥ 22 e o .NET Framework 4.x incluído no Windows. Um plugin independente da comunidade; Codex descreve o estilo de interação.

## Novidades da 2.0.0

- **Recibos compactos por padrão** — o texto pós-ação normalmente acrescenta no máximo 6 KiB ao recibo da ação; `feedback: full` e `feedback: none` são alternativas explícitas.
- **Consultas UIA limitadas e ancoradas** — profundidade 6, 120 nós e um orçamento flexível de 1200 ms por padrão; consultas com profundidade maior que 6 ou mais de 300 nós precisam de um `anchor` medido.
- **Evidências sob demanda** — 4 MiB de memória + 32 MiB de disco, 64 registros, expiração em 24 horas; uma falha de disco recorre à memória limitada.
- **Aviso de preparação adaptativo** — 1 segundo inicialmente, 0,1 segundo dentro de uma janela móvel de 3 minutos; a pipa inclinada marca o ponto de clique do agente.
- **Caminho de entrada reforçado** — combinações de teclas de gerenciamento de janelas protegidas, contrapressão/recuperação do worker, verificações de alvos obsoletos e limpeza ao cancelar.

<details>
<summary>Versão atual e compatibilidade</summary>

**2.0.0** é a nova versão principal, distribuída inicialmente no canal `next` do npm enquanto decorre a janela de liberação de 24 horas. Veja [mudanças e migração da 2.0.0](docs/RELEASE-2.0.0.md). Consulte as tags do registry para a disponibilidade estável atual.

A versão 1.3.1 lê texto da tela pelo nome, detecta o desktop seguro do Windows e retoma sozinha, e mantém todas as cores no mesmo trilho de borda derivado do DPI, com um nível mínimo de respiração visível. A versão 1.3.0 libera o controle do desktop quando o trabalho termina enquanto o chat continua.

Correções anteriores: [1.2.3 atribuição de aprovação](docs/RELEASE-1.2.3.md) · [1.2.1 atenção nativa](docs/RELEASE-1.2.1.md) · [patch de host autônomo](docs/RELEASE-1.2.2.md).

</details>

## O que ele faz

A versão 2.0.0 também usa um ponteiro de pipa azul compacto durante a operação da IA e a retenção de cena. Sua ponta inclinada marca o ponto de clique, com pequenos símbolos de texto/redimensionamento dentro da pipa. Uma pipa que respira significa que a página e a posição do ponteiro devem permanecer no lugar; o modo livre restaura o cursor normal do aplicativo. O tema de cursor do Windows do usuário é preservado.

A versão 2.0.0 limita a travessia do UIA e usa texto pós-ação compacto por padrão. O feedback de imagem existente continua disponível; `feedback: compact|full|none` controla o nível de detalhe, e `verificationRegion: "x,y,w,h"` no clique nomeia a área de efeito esperada independentemente do ponto de entrada. O texto compacto normalmente acrescenta no máximo 6 KiB ao recibo original da ação. A evidência completa do ponto pode ser retida em um cache local limitado, com expiração, e recuperada sob demanda. Falha de disco recorre à memória limitada; se nenhum snapshot recuperável puder ser retido, a evidência atual é retornada embutida na íntegra, fora desse orçamento compacto, sem outra observação ou entrada.

Consultas UIA filtradas exigem `hwnd`. Os padrões são profundidade 6, 120 nós e um orçamento flexível de 1200 ms. Uma consulta com profundidade maior que 6 ou mais de 300 nós exige um `anchor:"x,y"` medido naquela janela; um `id` exato não contorna essa regra. Uma chamada ao provedor pode ultrapassar o orçamento flexível, e resultados parciais não podem estabelecer ausência ou unicidade. Após um atalho de gerenciamento de janelas, inspecione `computer_state {windows:true}`, ative a janela pretendida com sucesso e só então a observe antes de qualquer outra entrada de teclado.

- **Observar** — lista de janelas, capturas de tela (região / JPEG / PNG / reduzidas), um mapa Set-of-Marks dos elementos clicáveis e a árvore do UI Automation com `AutomationId`s exatos.
- **Agir** — clicar, mover, arrastar, rolar, selecionar um intervalo de texto, digitar, pressionar teclas e acionar controles por meio de seus próprios padrões de UI Automation, em vez de coordenadas às cegas.
- **Em lote** — uma chamada `computer_batch` executa uma lista de ações em série e para na primeira falha, de modo que uma sequência conhecida custa uma única rodada do modelo em vez de dez.
- **Perguntar** — `computer_ask` levanta uma pergunta no mesmo card de chat que o DSH usa para `ask_user_question`, sem contagem regressiva.
- **Um freio humano que chega ao modelo** — uma parada é injetada na sessão em execução, para que o agente saiba que foi interrompido em vez de descobrir isso no turno seguinte.

As ferramentas observam o desktop em vez de rastrear documentos do usuário. O plugin gerencia helpers nativos em `%LOCALAPPDATA%\dsh-computer-use\worker\`, além dos registros de auditoria, das capturas de tela e de seu próprio `observation-cache` limitado em `$DSH_HOME/data/computer-use/`. `computer_ctrl {action:"clear_cache"}` limpa o cache de observações deste Agente; não apaga capturas de tela, anexos ou documentos do usuário.

<a id="install-and-update-in-dsh-market"></a>

## Instalar e atualizar no dsh-market

Pesquise por **computer-use** ou **Codex-style** no mercado. Procure o repositório **ltmroberthk915/dsh-computer-use** e o pacote npm **dsh-codex-style-computer-use** (mantenedor: **ltmroberthk**) e clique em **Instalar**. Use **Atualizar** ou **Atualizar tudo** para atualizações do canal estável. Ambos os helpers nativos estão incluídos; não é necessário PowerShell 7 nem permissão de build.

Como alternativa, digite **`dsh-codex-style-computer-use`** em **Configurações → Plugins → Adicionar plugin** para o canal estável atual, ou **`dsh-codex-style-computer-use@2.0.0`** para a versão descrita aqui. Informe a especificação do pacote npm diretamente. Seu host pode aplicar um período de espera a versões novas; siga a indicação exibida. Um bundle recém-adicionado pode carregar a quente em hosts compatíveis; verifique se as ferramentas e a skill aparecem. Reinicie a partir da bandeja do sistema ao substituir uma versão já carregada, quando o cliente permanecer desatualizado ou quando o DSH reportar **restart-required**.

### Versões com menos de 24 horas

A configuração padrão não estrita do pnpm 11.7.0 registra automaticamente uma exceção de versão única e conclui a instalação. Uma instalação bem-sucedida em uma máquina não garante que outra máquina permita versões novas.

Com `minimumReleaseAgeStrict: true` (ou uma política de host que habilite verificações estritas de idade de release) e sem exceção aplicável, uma versão abaixo da idade configurada é rejeitada antes de o código do plugin ser executado. Verificou-se que o nome sem versão, um pin exato `@1.2.0` e a URL do tarball do npm falham com `ERR_PNPM_NO_MATURE_MATCHING_VERSION` sob essa política. Definir explicitamente `minimumReleaseAge: 1440` também habilita o comportamento estrito no pnpm 11.7.0, a menos que `minimumReleaseAgeStrict` seja definido separadamente como false. Reiniciar o DSH, instalar o PowerShell ou repetir o mesmo comando não resolve uma recusa por política estrita. A ponte oficial do desktop não aceita flags extras do pnpm.

Se uma política estrita bloquear a instalação, aguarde até que a versão atenda à idade configurada para instalar sem alterar a política. A versão 1.2.0 foi publicada em `2026-10-03T03:50:11.586Z`; ela atende ao corte de 24 horas após **2026-10-04 03:50:12 UTC** (11:50:12 na China). Um corte personalizado mais longo ou um mirror de registry atrasado pode adiar ainda mais a disponibilidade. Usuários padrão não estritos não precisam esperar nem editar a configuração para este pacote.

Se você optar explicitamente por instalar antes, mescle esta exceção de versão única no `pnpm-workspace.yaml` existente do perfil de destino e tente novamente a instalação pelo mercado. Preserve as outras entradas; não desative a política global de idade:

```yaml
minimumReleaseAgeExclude:
  - dsh-codex-style-computer-use@1.2.0
```

O caminho padrão no desktop é `%USERPROFILE%\.dsh\profiles\desktop\pnpm-workspace.yaml`; use o diretório real se `DSH_HOME` for personalizado. Remova esta exceção depois que a versão amadurecer, se desejar.

As correções anteriores de documentação e de verificação do publicador não alteraram o runtime da 1.2.0 e não exigiram reinstalação. A correção de atenção nativa na **1.2.1** exige sim uma atualização. Adicionar a mesma origem novamente pode produzir um erro de host `ambiguous-install` em alguns caminhos de instalação; reinstalar a 1.2.0 não aplicará a correção da 1.2.1.

**Migrando uma instalação antiga via Git/tarball deste repositório:** remova a entrada antiga **dsh-computer-use** no mercado e instale **dsh-codex-style-computer-use**. O nome npm sem escopo `dsh-computer-use` pertence a outro repositório; não o instale como atualização deste plugin. Uma instalação via Git não pode trocar sua identidade de dependência apenas buscando um novo commit. Depois dessa migração única pela UI, use as atualizações normais do mercado. Os nomes de ferramenta `computer_*` existentes e o namespace de configurações `computer-use` são mantidos.

**Preserve também sua configuração salva:** faça uma cópia de segurança do `cordis.patch.yml` do perfil e altere apenas `name: dsh-computer-use` em um override com `id: computer-use` para `name: dsh-codex-style-computer-use`. Mantenha todos os seus campos `config` e `disabled`. Reter apenas o namespace de configurações não basta: um nome divergente faz o DSH ignorar até overrides `read-only`, `dryRun` e de estado desabilitado. Não substitua outros plugins nem um patch de home compartilhado globalmente. O `scripts/migrate-profile.mjs` do repositório faz pré-visualização por padrão; `--apply` cria um backup e substitui o arquivo atomicamente, recusando edições concorrentes.

Como alternativa, baixe o [utilitário de migração de configuração](https://github.com/ltmroberthk915/dsh-computer-use/releases/download/v1.2.0/computer-use-profile-migration.zip), extraia-o e dê dois cliques em `migrate-profile.cmd`. Ele localiza o aplicativo Desktop oficial instalado e usa o Windows PowerShell 5.1 e o Node incluído no DSH para reparar o perfil desktop padrão. Ele para se o novo bundle estiver ausente ou se o bundle antigo ainda estiver selecionado. Não altera a política de idade de release. Para outro perfil, execute `migrate-profile.ps1 -ProfileDirectory <absolute-directory>` para pré-visualizar e depois adicione `-Apply` quando estiver pronto.

O Release do GitHub também inclui `dsh-computer-use.tgz` para instalação offline/manual; a instalação pelo registry é o padrão para atualizações do mercado.

Usuários de CLI (perfil web):

```sh
dsh plugin --profile web add dsh-codex-style-computer-use
```

Os diagnósticos do desktop devem usar a **CLI incluída no aplicativo Desktop oficial**:

```powershell
$CuDshInstall = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
& "$CuDshInstall\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop why dsh-codex-style-computer-use
```

Para uma instalação personalizada, defina `$CuDshInstall` como o diretório no destino do atalho do Desktop. Um `dsh` global mais antigo do npm pode rejeitar o perfil desktop. Não adicione `resources/runtime/bin` ao PATH global nem instale um pnpm separado para esta tarefa. Prefira a interface do plugin para instalar.

## A skill incluída

As ferramentas de condução permanecem bloqueadas até que a sessão produza a frase de recibo que existe apenas dentro de `skills/computer-use/SKILL.md`. Isso é intencional — é a versão honesta mais forte de "leia o manual antes de conduzir", porque nenhuma camada de ferramentas consegue ver se um modelo leu um documento.

O plugin registra a skill incluída por meio de `ctx.skills.register()` quando disponível. Se esse serviço estiver ausente, `computer_use_activate` retorna o mesmo manual, seu caminho absoluto de origem e a lista de ferramentas no escopo. O recibo e todas as verificações existentes de aprovação/freio continuam se aplicando.

## Entrada compartilhada na 1.2.0-rc.2

Esta pré-versão introduz a tomada de controle imediata pelo humano, a espera automática após 2 segundos de entrada contínua e a continuação após 3 segundos de silêncio. A espera ocorre localmente, sem polling do modelo. Escritas interrompidas exigem uma nova leitura de verificação e nunca são repetidas às cegas. O cancelamento pelo host libera a entrada aceita de propriedade da automação sem criar uma nova pausa persistente. O tratamento existente do DSH Pet/janela principal e de topo original é mantido.

As rotas configuradas GLM 5.3 Max, GLM 5.3 Flash e DeepSeek Flash passaram em um teste controlado do protocolo de continuação. Entrada nativa e atalhos físicos foram verificados separadamente; este não é um benchmark geral de desktop ou de visão. Veja [a verificação do release](docs/RELEASE-1.2.0-rc.2.md) para o escopo.

## Controles sob demanda na 1.1

- **Ferramentas por Agente:** Agentes ociosos veem `computer_use_activate`, `computer_ctrl` e `computer_ask`. Um carregamento bem-sucedido da skill computer-use, um recibo ou uma ativação expõe as 19 ferramentas de desktop mais a entrada de ativação àquele Agente. Outros Agentes e filhos ativam de forma independente. Chamadas nativas e `run_code` do Node são suportadas. A ativação não inicia o controle nem libera um freio humano.
- **Alvos UIA observados:** uma consulta de nome/id no escopo retorna um handle de alvo opaco. Use-o em ações baseadas em padrões; a opção `rebind:true` permite recuperação de identidade única ou semântica após substituição na mesma janela. Contexto alterado, ambiguidade e varreduras incompletas são recusados. Consultas amplas ignoram handles de recuperação a menos que `targets:true`; criar testemunhas para uma lista grande custa trabalho nativo extra.
- **Observações incrementais:** informe o ID da observação anterior como `since` com a mesma consulta. Os deltas preservam adições, alterações, remoções e ordenação. Os snapshots são isolados por Agente, com no máximo 64 observações indexadas e 4 MiB de JSON retido por armazenamento. `snapshot` recupera um resultado histórico retido; `offset` e `limit` paginam seus arrays. Bases ausentes, escopo alterado, evidência incompleta ou um delta maior recorrem à saída completa.

Veja [o protocolo detalhado](skills/computer-use/references/progressive-control.md) para limites de cache e fronteiras de recuperação. Os snapshots UIA preservam os campos retornados pelo provedor dentro dos limites existentes do provedor; a recuperação histórica não é uma verificação atual do resultado.

## Ferramentas

| Grupo | Ferramentas |
|---|---|
| Ativar | `computer_use_activate` |
| Observar | `computer_state` `computer_shot` `computer_ocr` `computer_marks` `computer_uia` |
| Agir | `computer_click` `computer_move` `computer_drag` `computer_scroll` `computer_select` `computer_key` `computer_type` `computer_uia_act` `computer_window` `computer_clip` |
| Fluxo | `computer_wait` `computer_batch` |
| Meta | `computer_ask` `computer_ctrl` |

`computer_marks` retorna marcas numeradas para os elementos que encontrou na tela; `computer_marks {shot:true}` também salva uma imagem anotada. `computer_shot` retorna uma captura de tela simples e, em rotas com suporte a imagem, um anexo de imagem nativo. Uma marca é um ID de snapshot: ela é validada com base na identidade da janela e em pixels amostrados antes de qualquer entrada ser enviada, de modo que uma marca obsoleta é recusada em vez de clicada no lugar errado.

## Modos de aprovação

Para um host que relata uma recusa automática por prompt desabilitado como "o usuário rejeitou a ferramenta", veja o [patch de atribuição de aprovação do DSH e teste de regressão](docs/APPROVAL-ATTRIBUTION.md).

`automationMode` é definido nas configurações do plugin e tem `standard` como padrão:

| Modo | Observação | Atuação |
|---|---|---|
| `read-only` | permitida | negada |
| `standard` | permitida | toda ação pergunta pelo card de aprovação do host |
| `autonomous` | permitida | permitida, operações de alto risco ainda perguntam |
| `unrestricted` | permitida | permitida (proteção contra falhas e limite de taxa do worker ainda se aplicam) |

Operações de alto risco (fechar uma janela, `alt+f4`, `win+r` e similares) perguntam em todos os modos. Campos de senha são detectados pelo `IsPassword` do UI Automation e recusados por padrão.

## Modelo de segurança

- **Entrada compartilhada** — a atividade normal do usuário é permitida enquanto o agente pensa, observa ou se prepara. Durante a atuação propriamente dita, digitação, rolagem e botões cedem imediatamente; o movimento do ponteiro tem tolerância de deslocamento de 16 pixels. Entrada contínua ou uma tecla/botão mantido por 2 segundos entra em espera automática. Após a liberação e 3 segundos de silêncio, o agente deve inspecionar o alvo atual e continuar a tarefa original, sem repetir às cegas escritas parciais. Um gradiente de borda amarelo-claro suave indica a posse humana.
- **Pausa manual** — somente o `Ctrl+Esc` físico aciona um freio de entrada persistente; `Ctrl+Alt+R` retoma. Esc comum, digitação, rolagem, distância/frequência do ponteiro e o canto da tela não criam essa pausa. Retenções explícitas de pergunta/diagnóstico permanecem separadas.
- **Saída** — `Ctrl+Alt+Q` encerra a sessão: o overlay desaparece, seus listeners são desmontados e qualquer atuação adicional é recusada até que um turno posterior abra um novo.
- **O freio é um fato da máquina, não de um processo** — o estado acionado é persistido, e todo worker o adota, inclusive um iniciado depois a partir de um shell.
- **Auditoria** — toda atuação é acrescentada a `$DSH_HOME/data/computer-use/audit.jsonl` com sanitização dos argumentos.
- **Interruptor de emergência do próprio plugin** — `DSH_COMPUTER_USE_KILL=1` faz o plugin se recusar a iniciar; `dryRun: true` simula atuações e apenas as registra.

## Configuração

| Chave | Padrão | Significado |
|---|---:|---|
| `automationMode` | `standard` | modo de aprovação (acima) |
| `progressiveTools` | `true` | ativação por Agente; `false` expõe as 19 ferramentas de desktop globalmente |
| `actionFeedback` | `true` | observa automaticamente após ações diretas e lotes |
| `actionFeedbackDetail` | `compact` | `compact`, `full` ou `none`; o `feedback` de uma chamada substitui este padrão; evidências não armazenadas em cache recorrem à saída completa embutida |
| `dryRun` | `false` | simula atuações, apenas registra |
| `maxActionsPerMinute` | `60` | limite de taxa de atuação no nível do núcleo |
| `annotateMarks` | `true` | desenha caixas Set-of-Marks nas capturas de tela |
| `workerExe` | `""` | caminho explícito do worker; vazio = descoberta automática ou compilação |
| `snapshotDir` | `""` | diretório de capturas de tela; vazio = `$DSH_HOME/data/computer-use/shots` |

## Servidor MCP

`mcp/` é um servidor MCP stdio sem dependências sobre o mesmo núcleo, para clientes que falam MCP em vez de Cordis:

```sh
node mcp/src/index.js
```

O servidor embutido reporta a versão deste pacote raiz. Ele inicia apenas com observação. O host que o inicia pode definir `DSH_CU_ALLOW_INPUT=1` quando detém a autorização para ações de desktop; chamadas de ferramentas MCP não podem habilitar entrada. A ferramenta de compatibilidade `cu_approve` apenas reporta esta regra e nunca concede consentimento. A política `automationMode` do DSH pertence ao adaptador Cordis e não é um serviço de aprovação MCP. `DSH_CU_DRY_RUN=1` simula entrada que o host já habilitou.

Ambos os adaptadores usam a mesma gramática de comandos de tecla, as mesmas regras de falha e continuação de lote e o mesmo mapeamento de coordenadas de imagem. O MCP retorna metadados de captura estruturados e uma imagem PNG/JPEG mais recente, sem serializar bytes de imagem em texto JSON. `cu_hold` / `cu_free` reservam ou liberam a cena entre ações; `cu_release` encerra o ciclo do desktop. `cu_drag` aceita verificações `expectCursor` e `hwnd`. O MCP expõe uma superfície de ferramentas menor; a integração específica do DSH com perguntas ao humano e com o ciclo de vida do host é fornecida pelo adaptador Cordis.

## Desenvolvimento

As verificações de release do publicador usam o registry oficial do npm por padrão. Se essa origem estiver inacessível na sua rede, `CU_REGISTRY` seleciona um mirror explícito para o comando `check` somente leitura; o resultado JSON inclui `registry` e `authoritative`. Exemplo no PowerShell (isto altera apenas o shell atual):

```powershell
$env:CU_REGISTRY = 'https://registry.npmmirror.com'
node scripts/release-channel.mjs check 1.2.0
Remove-Item Env:CU_REGISTRY
```

O código de saída `0` significa que a versão passou na verificação de 24 horas do publicador, `2` significa que ela ainda está em resfriamento e `1` significa que a verificação falhou. Uma falha de rede não estabelece que um pacote não foi publicado, e mirrors podem ficar desatualizados. `promote` sempre verifica novamente e grava em `https://registry.npmjs.org`, ignorando `CU_REGISTRY`; ele precisa de acesso a essa origem, usando a configuração de proxy do npm quando necessário. Esta ferramenta de publicação não faz parte da instalação do usuário final. Veja [o procedimento de release](docs/RELEASE-1.2.0.md).

O repositório inclui a suíte de guardas que protege as invariantes acima — o tempo de vida do ciclo, o protocolo de pergunta/freio, a classificação de operações, o portão da skill e a ligação da skill incluída:

```sh
pwsh -NoProfile -ExecutionPolicy Bypass -File build/run-guards.ps1   # all guards
node build/verify-tools-schema.mjs                                   # tool-schema load guard
```

As definições de ferramentas são compiladas pela DSL real `@deepseek-ai/dsh-tools`, de modo que um erro de schema falha aqui em vez de derrubar a árvore de plugins do host na reinicialização. Algumas guardas compilam o worker nativo e são exclusivas do Windows.

## Licença

MIT — veja [LICENSE](LICENSE).
