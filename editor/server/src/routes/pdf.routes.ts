import { Router } from 'express';
import type { z } from 'zod';
import { actorFromReq, audit } from '../logger.js';
import { validate } from '../middleware/validate.js';
import { PdfRequest } from '../openapi/schemas.js';
import { htmlToPdf } from '../pdf/vivliostyle.js';

export const pdfRouter = Router();

pdfRouter.post('/pdf', validate(PdfRequest), async (req, res) => {
  const body = req.body as z.infer<typeof PdfRequest>;
  const detail = { htmlBytes: body.html.length, cssBytes: body.css.length };
  try {
    const pdf = await htmlToPdf(body.html, body.css);
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
    throw e;
  }
});
