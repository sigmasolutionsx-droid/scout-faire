document.addEventListener('DOMContentLoaded', function() {
  const tooltipTriggers = document.querySelectorAll('.tooltip-trigger');
  
  tooltipTriggers.forEach(trigger => {
    trigger.addEventListener('mouseenter', function(e) {
      const tooltipId = this.dataset.tooltip;
      const tooltip = document.getElementById('tooltip-' + tooltipId);
      
      if (tooltip) {
        const rect = this.getBoundingClientRect();
        tooltip.style.display = 'block';
        tooltip.style.top = (rect.bottom + 10) + 'px';
        tooltip.style.left = Math.max(10, rect.left - 100) + 'px';
      }
    });
    
    trigger.addEventListener('mouseleave', function() {
      const tooltipId = this.dataset.tooltip;
      const tooltip = document.getElementById('tooltip-' + tooltipId);
      if (tooltip) {
        tooltip.style.display = 'none';
      }
    });
  });
});

async function startFreePlan() {
  window.location.href = '/api/login';
}

async function selectPlan(tier) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Redirecting...';
  
  try {
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: tier })
    });
    
    const data = await response.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
      btn.disabled = false;
      btn.textContent = tier === 'enterprise' ? 'Schedule Demo' : 'Start 7-Day Free Trial';
    }
  } catch (error) {
    alert('Error: ' + error.message);
    btn.disabled = false;
    btn.textContent = tier === 'enterprise' ? 'Schedule Demo' : 'Start 7-Day Free Trial';
  }
}

async function startProTrial() {
  selectPlan('pro');
}

async function startEnterprise() {
  selectPlan('enterprise');
}
