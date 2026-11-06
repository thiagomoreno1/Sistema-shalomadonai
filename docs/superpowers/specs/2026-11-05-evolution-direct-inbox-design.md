# WhatsApp nativo do Shalom com Evolution API

## Objetivo

Usar a Evolution API como integração direta do Shalom com o WhatsApp, sem Chatwoot. A tela de Atendimento deve reunir conversas, mensagens, arquivos recebidos, contatos, estados de entrega e registros de chamadas, além do contexto de cliente e pedido.

## Escopo realista

“Todas as funções do WhatsApp” não é um contrato único: o WhatsApp tem recursos no aplicativo que a Evolution não expõe em todas as integrações, e o suporte também varia entre Baileys e Cloud API. A aplicação deve habilitar cada recurso conforme houver evento/endpoint verificável para a versão e canal conectados.

### Primeira entrega

- Caixa própria do Shalom abastecida por eventos da Evolution.
- Mensagens diretas de texto, status de envio, histórico e leitura na caixa.
- Metadados de imagem, áudio, vídeo e documento recebidos; evolução do envio e prévia de mídia pode ser entregue em etapas sem armazenar Base64 bruto em eventos.
- Registro de eventos de chamada com direção/estado, data e indicador de vídeo quando emitidos pelo provedor. Não inclui áudio gravado, atendimento de chamada ao vivo nem controles de chamada dentro do navegador.
- Identificação do cliente por telefone brasileiro normalizado: associação automática somente quando houver exatamente um cadastro ativo correspondente; usa `remoteJidAlt` quando a Evolution envia um telefone alternativo para um identificador `@lid`; correspondência ambígua exige seleção manual.
- Histórico de chamadas vinculado ao cliente e à conversa quando a relação for conhecida.
- Ações locais de abrir/resolver conversa, marcar leitura e relacionar cliente/pedido.
- Exibição de estado conectado/desconectado e configuração do webhook a partir do backend.

### Próximas etapas compatíveis

1. Mídia ponta a ponta: carregar anexos recebidos sob demanda e enviar imagem/áudio/vídeo/documento com validação de tipo/tamanho.
2. Recursos de conversa: responder citando mensagem, reações, edição/exclusão quando a integração e versão oferecerem as rotas correspondentes.
3. Contatos e grupos: sincronização de nome/foto, grupos, participantes e regras específicas de privacidade.
4. Recursos adicionais que forem confirmados por versão/canal: presença, etiquetas, localização, contatos, listas/botões, status e automações.

Cada item continua desligado ou identificado como indisponível até a capacidade ser confirmada. Não haverá promessa de paridade completa com o aplicativo WhatsApp.

## Identidade de cliente

- Normalizar pontuação e espaços e, para números brasileiros locais de 10 ou 11 dígitos, acrescentar o código do país `55`; números E.164 são normalizados para a mesma forma.
- Comparar números completos normalizados, sem correspondência por sufixo que possa associar pessoas diferentes.
- Considerar `phone` e `whatsapp_phone` do mesmo cadastro como uma pessoa só.
- Associar automaticamente apenas uma correspondência ativa única e marcar o vínculo como `phone`.
- Quando um cadastro novo ou telefone atualizado corresponder a uma conversa já recebida, criar/atualizar o vínculo automático sem exigir nova mensagem.
- Se houver mais de um cliente correspondente, nenhum vínculo automático é criado. A equipe escolhe manualmente.
- Um vínculo manual nunca é sobrescrito por nova sincronização. Não mesclar nem alterar cadastros de clientes automaticamente.

## Segurança e infraestrutura

- A chave global Evolution, chave Supabase de servidor e segredo do webhook ficam no servidor/local env ignorado pelo Git.
- Webhook com JWT Supabase desativado valida um segredo específico em tempo constante antes de escrever.
- Instância e empresa são definidas por secrets de servidor, nunca pelo corpo recebido ou pelo navegador.
- Webhooks idempotentes por identificador da mensagem/chamada e evento.
- Dados acessíveis apenas para membros ativos da mesma empresa. Entregadores não acessam a caixa; equipe pode consultar/responder; alteração de vínculos permanece restrita à gestão.
- Nenhum payload Base64 ou objeto bruto completo do provedor é persistido.
- Preservar histórico e migration do Chatwoot sem reutilizar IDs numéricos; remover Chatwoot do fluxo do produto.
- Evolution v2.3.7 permanece local e presa ao loopback do computador. Não publicar esta versão diretamente na internet.
- O serviço local não é alcançável pelo Supabase hospedado. Teste na prévia hospedada requer Evolution corrigida e acessível por HTTPS/rede privada; associação de número real somente após validação e com participação da pessoa responsável.

## Tratamento de chamadas

- Persistir somente eventos/metadados fornecidos pela Evolution; nunca inferir “atendida”, “perdida” ou duração sem campos confirmados do evento.
- Uma chamada pode chegar com `@lid`, sem telefone. Mostrar “Contato sem identificação” e permitir associação manual.
- A versão 2.3.7 tem relato recente de que configuração de recusa/resposta automática pode causar erro e suprimir o evento de chamada `offer` para certos `@lid`. Não ativar essa configuração por este sistema; mostrar que a completude do log depende do evento chegar.
- Call log deve aparecer na área de Atendimento e no contexto do cliente quando vinculado.

## Critérios de aceite da primeira entrega

1. `/whatsapp` abre a caixa nativa do Shalom sem Chatwoot.
2. Configuração ausente aparece como pendente; o sistema não finge conexão ativa.
3. Webhook inválido não grava dados; reenvio do mesmo evento não duplica mensagens/chamadas.
4. Eventos recebidos criam/atualizam conversa e aparecem na lista e no histórico.
5. Correspondência por número é exata após normalização, única, restrita à empresa e preserva vínculo manual.
6. O log de chamadas é persistido mesmo quando o telefone do interlocutor não é conhecido.
7. Credenciais não aparecem em `VITE_*`, interface, logs ou Git.
8. README explica como rodar localmente, ligar redes Docker e o que falta para o teste ponta a ponta.
