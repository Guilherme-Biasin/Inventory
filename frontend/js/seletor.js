// ═══════════════════════════════════════════════════════════════
//  seletor.js — lista suspensa e calendário próprios
//
//  O <select> e o <input type="date"> do navegador herdam a aparência do
//  Windows: fonte, cores e cantos que não têm nada a ver com o resto da tela,
//  e que mudam de máquina para máquina. Aqui eles ganham a cara do sistema.
//
//  COMO FUNCIONA, e por que assim: o campo NATIVO continua no HTML, escondido
//  atrás do controle bonito. Todo o resto do sistema continua lendo e
//  escrevendo `document.getElementById('a_categoria').value` como sempre, e
//  quem escolhe pelo controle novo dispara o mesmo evento `change` de antes.
//  Nada precisou ser reescrito, e se este arquivo falhar ao carregar, os
//  campos voltam a aparecer como eram — feios, mas funcionando.
//
//  Os formulários são redesenhados por innerHTML a cada render, então um
//  observador cuida de enfeitar o que nasce depois e de atualizar o rótulo
//  quando o valor ou a lista de opções muda no código.
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const MESES = ['janeiro','fevereiro','março','abril','maio','junho',
                 'julho','agosto','setembro','outubro','novembro','dezembro'];
  const DIAS  = ['D','S','T','Q','Q','S','S'];

  // Escape local: este arquivo carrega antes do app.js poder existir.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
      .replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function fecharTudo(exceto) {
    document.querySelectorAll('.pk.aberto, .dp.aberto').forEach(el => {
      if (el !== exceto) el.classList.remove('aberto');
    });
  }

  // ─── LISTA SUSPENSA ──────────────────────────────────────────
  function enfeitarSelect(nativo) {
    if (nativo.dataset.enfeitado) return;
    nativo.dataset.enfeitado = '1';

    const caixa = document.createElement('div');
    caixa.className = 'pk';
    nativo.parentNode.insertBefore(caixa, nativo);
    caixa.appendChild(nativo);

    // O nativo sai da navegação por Tab: quem recebe o foco é o botão.
    nativo.classList.add('pk-nativo');
    nativo.tabIndex = -1;
    nativo.setAttribute('aria-hidden', 'true');

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = nativo.className.replace('pk-nativo', '').trim() + ' pk-btn';
    botao.setAttribute('aria-haspopup', 'listbox');
    botao.setAttribute('aria-expanded', 'false');
    if (nativo.disabled) botao.disabled = true;
    botao.innerHTML = '<span class="pk-rot"></span><i class="ti ti-chevron-down pk-ico"></i>';

    const painel = document.createElement('div');
    painel.className = 'pk-painel';
    painel.setAttribute('role', 'listbox');

    caixa.appendChild(botao);
    caixa.appendChild(painel);

    botao.addEventListener('click', e => {
      e.stopPropagation();
      if (botao.disabled) return;
      const abrir = !caixa.classList.contains('aberto');
      fecharTudo(caixa);
      if (abrir) montarOpcoes(nativo, painel, botao);
      caixa.classList.toggle('aberto', abrir);
      botao.setAttribute('aria-expanded', abrir ? 'true' : 'false');
      if (abrir) {
        const sel = painel.querySelector('.pk-item.sel') || painel.querySelector('.pk-item');
        if (sel) sel.focus();
      }
    });

    // Teclado no botão: seta para baixo abre, letra escolhe direto.
    botao.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); botao.click(); }
    });

    atualizarRotulo(nativo);
  }

  function montarOpcoes(nativo, painel, botao) {
    const opcoes = [...nativo.options];
    painel.innerHTML = opcoes.map((o, i) =>
      `<button type="button" class="pk-item${o.selected ? ' sel' : ''}${o.disabled ? ' off' : ''}"
         role="option" aria-selected="${o.selected}" data-i="${i}" ${o.disabled ? 'aria-disabled="true"' : ''}
         title="${esc(o.textContent)}">${esc(o.textContent) || '&nbsp;'}</button>`).join('')
      || '<div class="pk-vazio">Nenhuma opção</div>';

    painel.querySelectorAll('.pk-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('off')) return;
        escolher(nativo, opcoes[+item.dataset.i]);
        painel.parentElement.classList.remove('aberto');
        botao.setAttribute('aria-expanded', 'false');
        botao.focus();
      });
      item.addEventListener('keydown', e => navegarLista(e, item, painel, botao));
    });

    // O painel abre para CIMA quando não há espaço embaixo — senão a última
    // opção de um campo no fim da tela fica inalcançável.
    painel.classList.remove('acima');
    requestAnimationFrame(() => {
      const r = botao.getBoundingClientRect();
      const alturaPainel = painel.offsetHeight || 220;
      if (r.bottom + alturaPainel + 12 > window.innerHeight && r.top > alturaPainel + 12) {
        painel.classList.add('acima');
      }
    });
  }

  function navegarLista(e, item, painel, botao) {
    const itens = [...painel.querySelectorAll('.pk-item:not(.off)')];
    const i = itens.indexOf(item);
    if (e.key === 'ArrowDown') { e.preventDefault(); (itens[i + 1] || itens[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (itens[i - 1] || itens[itens.length - 1]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); itens[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); itens[itens.length - 1]?.focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') {
      painel.parentElement.classList.remove('aberto');
      botao.setAttribute('aria-expanded', 'false');
      if (e.key === 'Escape') { e.preventDefault(); botao.focus(); }
    } else if (e.key.length === 1) {
      // Digitar a inicial pula para a opção, como no campo nativo.
      const letra = e.key.toLowerCase();
      const alvo = itens.slice(i + 1).concat(itens.slice(0, i + 1))
        .find(x => x.textContent.trim().toLowerCase().startsWith(letra));
      if (alvo) { e.preventDefault(); alvo.focus(); }
    }
  }

  function escolher(nativo, opcao) {
    if (!opcao) return;
    nativo.value = opcao.value;
    atualizarRotulo(nativo);
    // O mesmo evento que o campo nativo dispararia: quem já escutava (por
    // exemplo o onchange que troca os status de Entrada/Saída) continua igual.
    nativo.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function atualizarRotulo(nativo) {
    const caixa = nativo.closest('.pk');
    if (!caixa) return;
    const rot = caixa.querySelector('.pk-rot');
    const op = nativo.options[nativo.selectedIndex];
    const texto = op ? op.textContent.trim() : '';
    // "vazio" = a opção sem valor (Selecione..., Todas as categorias): fica
    // com a cor de texto de apoio, como um placeholder.
    rot.textContent = texto || ' ';
    rot.classList.toggle('vazio', !nativo.value);
    caixa.querySelector('.pk-btn').disabled = nativo.disabled;
  }

  // ─── CALENDÁRIO ──────────────────────────────────────────────
  function enfeitarData(nativo) {
    if (nativo.dataset.enfeitado) return;
    nativo.dataset.enfeitado = '1';

    const caixa = document.createElement('div');
    caixa.className = 'dp';
    nativo.parentNode.insertBefore(caixa, nativo);
    caixa.appendChild(nativo);

    nativo.classList.add('dp-nativo');
    nativo.tabIndex = -1;
    nativo.setAttribute('aria-hidden', 'true');

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = nativo.className.replace('dp-nativo', '').trim() + ' dp-btn';
    botao.innerHTML = '<span class="dp-rot"></span><i class="ti ti-calendar dp-ico"></i>';

    const painel = document.createElement('div');
    painel.className = 'dp-painel';

    caixa.appendChild(botao);
    caixa.appendChild(painel);

    botao.addEventListener('click', e => {
      e.stopPropagation();
      const abrir = !caixa.classList.contains('aberto');
      fecharTudo(caixa);
      if (abrir) desenharCalendario(nativo, painel, mesDe(nativo));
      caixa.classList.toggle('aberto', abrir);
    });
    botao.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); botao.click(); }
      if (e.key === 'Escape') caixa.classList.remove('aberto');
    });

    atualizarData(nativo);
  }

  // Mês que o calendário abre: o da data escolhida, ou o atual.
  function mesDe(nativo) {
    const v = (nativo.value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const hoje = new Date();
    return v ? { ano: +v[1], mes: +v[2] - 1 } : { ano: hoje.getFullYear(), mes: hoje.getMonth() };
  }

  function iso(ano, mes, dia) {
    return ano + '-' + String(mes + 1).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
  }

  function desenharCalendario(nativo, painel, ref) {
    const hoje = new Date();
    const hojeIso = iso(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const escolhido = nativo.value || '';
    const primeiro = new Date(ref.ano, ref.mes, 1).getDay();
    const total = new Date(ref.ano, ref.mes + 1, 0).getDate();

    let celulas = '';
    for (let i = 0; i < primeiro; i++) celulas += '<span></span>';
    for (let d = 1; d <= total; d++) {
      const data = iso(ref.ano, ref.mes, d);
      const classes = ['dp-dia'];
      if (data === escolhido) classes.push('sel');
      if (data === hojeIso) classes.push('hoje');
      celulas += `<button type="button" class="${classes.join(' ')}" data-data="${data}">${d}</button>`;
    }

    painel.innerHTML = `
      <div class="dp-cab">
        <button type="button" class="dp-nav" data-passo="-1" title="Mês anterior"><i class="ti ti-chevron-left"></i></button>
        <b>${esc(MESES[ref.mes])} de ${ref.ano}</b>
        <button type="button" class="dp-nav" data-passo="1" title="Próximo mês"><i class="ti ti-chevron-right"></i></button>
      </div>
      <div class="dp-semana">${DIAS.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="dp-grade">${celulas}</div>
      <div class="dp-rodape">
        <button type="button" class="dp-acao" data-acao="limpar">Limpar</button>
        <button type="button" class="dp-acao forte" data-acao="hoje">Hoje</button>
      </div>`;

    painel.querySelectorAll('.dp-nav').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      let mes = ref.mes + (+b.dataset.passo), ano = ref.ano;
      if (mes < 0) { mes = 11; ano--; }
      if (mes > 11) { mes = 0; ano++; }
      desenharCalendario(nativo, painel, { ano, mes });
    }));

    painel.querySelectorAll('.dp-dia').forEach(b => b.addEventListener('click', () => {
      definirData(nativo, b.dataset.data);
      painel.parentElement.classList.remove('aberto');
    }));

    painel.querySelectorAll('.dp-acao').forEach(b => b.addEventListener('click', () => {
      definirData(nativo, b.dataset.acao === 'hoje' ? hojeIso : '');
      painel.parentElement.classList.remove('aberto');
    }));

    painel.classList.remove('acima');
    requestAnimationFrame(() => {
      const r = painel.parentElement.getBoundingClientRect();
      if (r.bottom + painel.offsetHeight + 12 > window.innerHeight && r.top > painel.offsetHeight + 12) {
        painel.classList.add('acima');
      }
    });
  }

  function definirData(nativo, valor) {
    nativo.value = valor;
    atualizarData(nativo);
    nativo.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function atualizarData(nativo) {
    const caixa = nativo.closest('.dp');
    if (!caixa) return;
    const rot = caixa.querySelector('.dp-rot');
    const v = (nativo.value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    rot.textContent = v ? `${v[3]}/${v[2]}/${v[1]}` : 'dd/mm/aaaa';
    rot.classList.toggle('vazio', !v);
  }

  // ─── APLICAR E MANTER ────────────────────────────────────────
  function aplicar(raiz) {
    const alvo = raiz && raiz.querySelectorAll ? raiz : document;
    alvo.querySelectorAll('select:not([data-enfeitado])').forEach(enfeitarSelect);
    alvo.querySelectorAll('input[type="date"]:not([data-enfeitado])').forEach(enfeitarData);
    // Rótulos que mudaram por código (populateFilters, .value = x, troca de
    // opções ao escolher Entrada/Saída...).
    document.querySelectorAll('select[data-enfeitado]').forEach(atualizarRotulo);
    document.querySelectorAll('input[type="date"][data-enfeitado]').forEach(atualizarData);
  }

  // Um observador só, com folga de um quadro: os formulários são redesenhados
  // inteiros por innerHTML, e reagir a cada nó criado custaria caro à toa.
  let pendente = false;
  function agendar() {
    if (pendente) return;
    pendente = true;
    requestAnimationFrame(() => { pendente = false; aplicar(document); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    aplicar(document);
    new MutationObserver(agendar).observe(document.body, { childList: true, subtree: true });
    // Mudança feita por código não dispara 'change'; a que o usuário faz, sim.
    document.addEventListener('change', e => {
      if (e.target.matches && e.target.matches('select[data-enfeitado]')) atualizarRotulo(e.target);
      if (e.target.matches && e.target.matches('input[type="date"][data-enfeitado]')) atualizarData(e.target);
    }, true);
  });

  document.addEventListener('click', () => fecharTudo(null));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharTudo(null); });
  window.addEventListener('resize', () => fecharTudo(null));

  // Exposto para quem quiser forçar a atualização depois de mexer no DOM.
  window.aplicarSeletores = aplicar;
})();
