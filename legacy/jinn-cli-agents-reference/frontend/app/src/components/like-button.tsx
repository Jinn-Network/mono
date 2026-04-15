'use client';

import { useState, useEffect } from 'react';
import { Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toggleLike, getLikeStatus } from '@/app/actions';
import { usePrivy } from '@privy-io/react-auth';
import { toast } from 'sonner';

interface LikeButtonProps {
    ventureId: string;
    initialCount: number;
    className?: string;
}

export function LikeButton({ ventureId, initialCount, className }: LikeButtonProps) {
    const { user, authenticated } = usePrivy();
    const [liked, setLiked] = useState(false);
    const [count, setCount] = useState(initialCount);
    const [isLoading, setIsLoading] = useState(false);

    // Fetch initial like status
    useEffect(() => {
        if (authenticated && user?.wallet?.address) {
            getLikeStatus(ventureId, user.wallet.address)
                .then(setLiked)
                .catch(() => setLiked(false));
        }
    }, [authenticated, user, ventureId]);

    const handleToggle = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (!authenticated || !user?.wallet?.address) {
            toast.error('Please sign in to like ventures');
            return;
        }

        // Optimistic update
        const previousLiked = liked;
        const previousCount = count;

        setLiked(!liked);
        setCount(liked ? count - 1 : count + 1);
        setIsLoading(true);

        try {
            const result = await toggleLike(ventureId, user.wallet.address);
            if (result.error) throw new Error(result.error);
        } catch (error: any) {
            // Revert if failed
            setLiked(previousLiked);
            setCount(previousCount);
            console.error('Like toggle error:', error);
            toast.error(error instanceof Error ? error.message : 'Failed to update like');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Button
            variant="ghost"
            size="sm"
            className={cn("gap-1.5 px-2 hover:bg-transparent hover:text-red-500", className, liked && "text-red-500")}
            onClick={handleToggle}
            disabled={isLoading}
        >
            <Heart className={cn("h-4 w-4 transition-all", liked && "fill-current scale-110")} />
            <span className="text-xs font-medium tabular-nums">{count}</span>
        </Button>
    );
}
