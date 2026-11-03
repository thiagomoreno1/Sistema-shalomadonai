# Chatwoot na VPS

Este bundle prepara o Chatwoot para uma VPS Linux. A Contabo é a hospedagem pretendida, mas nenhum servidor, domínio ou número foi provisionado.

O Chatwoot recebe o canal oficial da WhatsApp Business Platform. O Shalom usa uma caixa nativa conectada à API do Chatwoot por uma Edge Function do Supabase. A tela não incorpora o WhatsApp Web nem automatiza sessões do aplicativo.

## Requisitos antes de publicar

- VPS Linux com pelo menos 4 GB de RAM, 4 núcleos recomendados e 1 GB de swap; dimensione espaço para conversas e anexos.
- Domínio ou subdomínio com registro DNS `A` apontando para o IP público da VPS.
- Firewall permitindo entrada em `80/tcp`, `443/tcp` e `443/udp`; SSH restrito ao administrador.
- Docker Engine e Docker Compose v2 instalados.
- Conta SMTP configurada para recuperar senhas e convidar a equipe.
- Plano de backup externo para PostgreSQL e anexos, com restauração testada.

O Compose publica somente o Caddy nas portas web. Rails e Sidekiq não têm portas publicadas; eles mantêm saída de rede para chamadas externas, como Meta e SMTP. PostgreSQL e Redis ficam somente na rede Docker interna. O armazenamento local persiste em volumes Docker, mas os volumes não substituem backup externo.

## Preparar e iniciar

No servidor, coloque estes arquivos em um diretório privado, copie `.env.example` para `.env` e edite o novo arquivo:

```sh
cp .env.example .env
```

Defina o domínio real, o e-mail para certificados HTTPS, os parâmetros SMTP e os três segredos aleatórios. Gere os segredos no próprio servidor com `openssl rand -hex 32`; não os salve no repositório nem os envie pelo chat. O arquivo `.env` é ignorado pelo Git.

Troque `BOOTSTRAP_ADMIN_IP` pelo IP público (ou CIDR) da rede que usará para o primeiro acesso. Durante o bootstrap, deixe o DNS apontando diretamente para a VPS, sem proxy/CDN, para o Caddy identificar esse IP. O Caddy libera `/installation/onboarding` somente para esse IP; a rota cria o primeiro superadministrador e se fecha após a configuração inicial. Mantenha `ENABLE_ACCOUNT_SIGNUP=false` para bloquear cadastros públicos comuns. Se o IP mudar antes da configuração, atualize o `.env` e recrie o Caddy.

Valide a configuração e prepare o banco:

```sh
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml run --rm rails bundle exec rails db:chatwoot_prepare
docker compose --env-file .env -f compose.yaml up -d
```

Caddy solicitará e renovará os certificados HTTPS automaticamente quando o DNS e as portas estiverem acessíveis. Confirme que o domínio abre por HTTPS antes de conectar qualquer canal.

Na primeira inicialização, abra `https://<domínio>/installation/onboarding` a partir da rede autorizada e crie o superadministrador. A rota de instalação é independente do cadastro público, que permanece desativado. O SMTP deve estar funcional para que convites e recuperação de acesso cheguem à equipe.

## Atualização e recuperação

As imagens têm versões fixadas. Para atualizar, escolha uma versão Chatwoot aprovada, altere a tag nos serviços `rails` e `sidekiq`, faça backup externo do banco e dos anexos, baixe as imagens, execute `db:chatwoot_prepare` e então recrie os serviços. Não atualize a imagem antes do backup.

O diretório persistente de anexos é `/app/storage`; PostgreSQL, Redis e certificados também usam volumes nomeados. Antes de atender conversas reais, configure cópias externas criptografadas do banco e de `/app/storage`, mantenha cópia das configurações e ensaie uma restauração. Este bundle não agenda nem envia backups.

## Etapas ainda necessárias para a integração

1. Escolher e provisionar a VPS e o domínio.
2. Concluir o primeiro acesso seguro e o SMTP.
3. Criar o inbox do Chatwoot e conectar o número pela Meta.
4. Configurar as credenciais no Supabase Edge Function e aplicar a migration de vínculos, após autorização para mudanças no projeto hospedado.
5. Validar recebimento, resposta, anexos, vínculo com pedido/cliente e falhas antes de considerar a integração ativa.
