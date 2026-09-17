import { useState } from 'react';
import { Expand } from 'lucide-react';
import { Modal } from '../ui';
import type { Card } from '../types';
export default function CardVisual({
  card,
  side,
  interactive = true,
}: {
  card: Card;
  side: 'question' | 'answer';
  interactive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const image = card?.image;
  if (!image || image.side !== side) return null;
  const url = `/api/assets/${image.assetId}${image.cropId ? '/crop/' + image.cropId : ''}`;
  return (
    <>
      <figure className="card-visual">
        <img src={url} alt={image.alt} />
        <figcaption>{image.caption || image.reason}</figcaption>
        {interactive && (
          <button type="button" className="text-button visual-expand" onClick={() => setOpen(true)}>
            <Expand size={12} />
            View diagram
          </button>
        )}
      </figure>
      {interactive && (
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="Source diagram"
          description={image.caption || image.alt}
          wide
        >
          <img className="expanded-diagram" src={url} alt={image.alt} />
          <p className="small muted">{image.reason}</p>
        </Modal>
      )}
    </>
  );
}
