import { Router } from 'express';
import { z } from 'zod';
import { actorFromReq, audit } from '../logger.js';
import { htmlToPdf } from '../pdf/vivliostyle.js';

export const pdfRouter = Router();

const schema = z.object({
  html: z.string().min(1),
  css: z.string().default(''),
});

pdfRouter.post('/pdf', async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'html is required' });
    return;
  }
  const detail = { htmlBytes: parsed.data.html.length, cssBytes: parsed.data.css.length };
  try {
    const pdf = await htmlToPdf(parsed.data.html, parsed.data.css);
    audit({
      event: 'pdf.export',
      outcome: 'success',
      ...actorFromReq(req),
      detail: { ...detail, pdfBytes: pdf.length },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
    res.send(pdf);
  } catch (e) {
    audit({
      event: 'pdf.export',
      outcome: 'failure',
      ...actorFromReq(req),
      detail,
      error: e instanceof Error ? e.message : 'PDF generation failed',
    });
    res.status(500).json({ error: e instanceof Error ? e.message : 'PDF generation failed' });
  }
});
